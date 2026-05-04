'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const audit = require('../services/audit');

const VALID_ALGORITHMS  = ['ECDSA_P256', 'ED25519'];
const VALID_PLATFORMS   = ['ANDROID', 'IOS'];
const REVOKE_REASONS    = ['LOST', 'REPLACED', 'COMPROMISED', 'OTHER'];

// POST /api/offline/devices/register
router.post('/register', requireAuth, idempotency, (req, res, next) => {
  try {
    const { deviceId, deviceName, publicSigningKey, keyAlgorithm, platform } = req.body;
    const { userId } = req.user;

    if (!deviceId || !publicSigningKey || !keyAlgorithm) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'deviceId, publicSigningKey, and keyAlgorithm are required.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }
    if (!VALID_ALGORITHMS.includes(keyAlgorithm)) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: `keyAlgorithm must be one of: ${VALID_ALGORITHMS.join(', ')}`,
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const db = getDb();

    // Idempotent re-registration — return existing active key
    const existing = db.prepare(
      `SELECT * FROM device_keys WHERE user_id = ? AND device_id = ? AND status = 'ACTIVE' LIMIT 1`
    ).get(userId, deviceId);
    if (existing) {
      return res.json({
        deviceId,
        publicKeyId: existing.public_key_id,
        status: existing.status,
        serverTime: new Date().toISOString(),
      });
    }

    // Retire any old keys for the same device
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE device_keys SET status = 'REPLACED', revoked_at = ?
        WHERE user_id = ? AND device_id = ? AND status IN ('ACTIVE','PENDING')`
    ).run(now, userId, deviceId);

    const publicKeyId = `devkey_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    db.prepare(`
      INSERT INTO device_keys (public_key_id, user_id, device_id, public_key, algorithm, status)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE')
    `).run(publicKeyId, userId, deviceId, publicSigningKey, keyAlgorithm);

    audit.record({
      eventType: 'DEVICE_REGISTERED',
      userId,
      deviceId,
      payload: { publicKeyId, algorithm: keyAlgorithm, platform: platform || 'UNKNOWN' },
    });

    return res.json({
      deviceId,
      publicKeyId,
      status: 'ACTIVE',
      serverTime: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// POST /api/offline/devices/revoke
router.post('/revoke', requireAuth, idempotency, (req, res, next) => {
  try {
    const { deviceId, reason, notes } = req.body;
    const { userId } = req.user;

    if (!deviceId || !reason) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'deviceId and reason are required.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }
    if (!REVOKE_REASONS.includes(reason)) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: `reason must be one of: ${REVOKE_REASONS.join(', ')}`,
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const db = getDb();
    const keys = db.prepare(
      `SELECT * FROM device_keys WHERE user_id = ? AND device_id = ? AND status IN ('ACTIVE','PENDING')`
    ).all(userId, deviceId);

    if (keys.length === 0) {
      return res.status(404).json({
        errorCode: 'DEVICE_NOT_REGISTERED',
        message: 'No active device found with that deviceId for this user.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const revokeStatus = reason === 'LOST' ? 'LOST' : reason === 'REPLACED' ? 'REPLACED' : 'REVOKED';
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE device_keys SET status = ?, revoked_at = ? WHERE user_id = ? AND device_id = ?`
    ).run(revokeStatus, now, userId, deviceId);

    audit.record({
      eventType: 'DEVICE_REVOKED',
      userId,
      deviceId,
      payload: { reason, notes: notes || null, revokeStatus },
    });

    return res.json({ deviceId, status: revokeStatus, serverTime: new Date().toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;
