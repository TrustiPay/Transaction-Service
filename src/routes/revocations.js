'use strict';

const router = require('express').Router();
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/offline/revocations?sinceCursor=cursor_123
router.get('/', requireAuth, (req, res, next) => {
  try {
    const { sinceCursor } = req.query;
    const since = sinceCursor
      ? new Date(Number(String(sinceCursor).replace('cursor_', ''))).toISOString()
      : new Date(0).toISOString();

    const db = getDb();
    const serverTime = new Date();
    const revocationCursor = `cursor_${serverTime.getTime()}`;

    const revokedDeviceKeys = db.prepare(`
      SELECT device_id, public_key_id FROM device_keys
      WHERE status IN ('REVOKED','LOST','REPLACED') AND revoked_at >= ?
    `).all(since);

    const revokedTokens = db.prepare(`
      SELECT token_id FROM offline_tokens
      WHERE status = 'REVOKED' AND spent_at >= ?
    `).all(since);

    const retiredServerKeys = db.prepare(`
      SELECT server_key_id FROM server_signing_keys
      WHERE status IN ('RETIRED','REVOKED') AND retired_at >= ?
    `).all(since);

    const revokedDeviceIds = [...new Set(revokedDeviceKeys.map((k) => k.device_id))];
    const revokedPublicKeyIds = revokedDeviceKeys.map((k) => k.public_key_id);

    return res.json({
      serverTime: serverTime.toISOString(),
      revocationCursor,
      revokedDeviceIds,
      revokedPublicKeyIds,
      revokedTokenIds: revokedTokens.map((t) => t.token_id),
      retiredServerKeyIds: retiredServerKeys.map((k) => k.server_key_id),
    });
  } catch (err) { next(err); }
});

module.exports = router;
