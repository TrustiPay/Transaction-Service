'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { validate, settle, rejectTransaction } = require('../services/settlement');
const audit = require('../services/audit');
const config = require('../config');

// POST /api/offline/sync
router.post('/', requireAuth, idempotency, (req, res, next) => {
  try {
    if (!config.OFFLINE_PAYMENTS_ENABLED) {
      return res.status(403).json({
        errorCode: 'OFFLINE_DISABLED',
        message: 'Offline payments are not enabled.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const { deviceId, pendingTransactions = [], lastSyncCursor } = req.body;
    const { userId } = req.user;

    if (!deviceId) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'deviceId is required.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }
    if (!Array.isArray(pendingTransactions)) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'pendingTransactions must be an array.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const db = getDb();
    const serverTime = new Date().toISOString();
    const syncCursor = `cursor_${Date.now()}`;
    const settlementResults = [];
    const rejected = [];
    const disputed = [];

    for (const pending of pendingTransactions) {
      const {
        transactionId, paymentRequest, paymentOffer, paymentReceipt,
        spentTokenIds = [], senderUserId, receiverUserId,
        senderDeviceId, receiverDeviceId, amountMinor, currency,
        transportType, createdAtDevice,
      } = pending;

      if (!transactionId || !paymentOffer || !paymentReceipt) {
        rejected.push({ transactionId, errorCode: 'VALIDATION_ERROR', message: 'transactionId, paymentOffer, paymentReceipt are required' });
        continue;
      }

      // Idempotent — already processed?
      const existing = db.prepare('SELECT status, settled_at, rejection_reason FROM offline_transactions WHERE transaction_id = ?').get(transactionId);
      if (existing) {
        settlementResults.push({ transactionId, status: existing.status, settledAt: existing.settled_at });
        continue;
      }

      // Pre-create PENDING record so status is queryable while we process
      try {
        db.prepare(`
          INSERT OR IGNORE INTO offline_transactions
            (transaction_id, sender_user_id, receiver_user_id, sender_device_id, receiver_device_id,
             amount_minor, currency, status, offer_payload, receipt_payload, request_payload,
             transport_type, created_at_device)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
        `).run(
          transactionId,
          senderUserId || null,
          receiverUserId || null,
          senderDeviceId || null,
          receiverDeviceId || null,
          amountMinor || 0,
          currency || 'LKR',
          Buffer.from(paymentOffer, 'base64url'),
          Buffer.from(paymentReceipt, 'base64url'),
          paymentRequest ? Buffer.from(paymentRequest, 'base64url') : null,
          transportType || 'UNKNOWN',
          createdAtDevice || null,
        );
      } catch { /* row already exists */ }

      const item = {
        transactionId,
        paymentRequest: paymentRequest || '',
        paymentOffer,
        paymentReceipt,
        spentTokenIds,
        senderUserId: senderUserId || userId,
        receiverUserId: receiverUserId || '',
        senderDeviceId: senderDeviceId || deviceId,
        receiverDeviceId: receiverDeviceId || '',
        amountMinor: Number(amountMinor) || 0,
        currency: currency || 'LKR',
        transportType: transportType || 'UNKNOWN',
        createdAtDevice: createdAtDevice || serverTime,
      };

      const validation = validate(item);

      if (!validation.valid) {
        rejectTransaction(transactionId, validation.rejectionStatus, validation.rejectionReason);
        audit.record({
          eventType: 'OFFLINE_REJECTED',
          userId,
          deviceId,
          transactionId,
          payload: { status: validation.rejectionStatus, reason: validation.rejectionReason },
        });
        if (validation.rejectionStatus === 'REJECTED_DOUBLE_SPEND') {
          audit.record({ eventType: 'DOUBLE_SPEND_DETECTED', userId, deviceId, transactionId });
          disputed.push({ transactionId, status: validation.rejectionStatus, reason: validation.rejectionReason });
        } else {
          rejected.push({ transactionId, status: validation.rejectionStatus, reason: validation.rejectionReason });
        }
        continue;
      }

      if (validation.alreadySettled) {
        settlementResults.push({ transactionId, status: 'SETTLED', settledAt: serverTime });
        continue;
      }

      try {
        settle(item);
        settlementResults.push({ transactionId, status: 'SETTLED', settledAt: serverTime });
      } catch (err) {
        const errorBody = err.errorBody;
        if (errorBody && errorBody.errorCode === 'REJECTED_DOUBLE_SPEND') {
          rejectTransaction(transactionId, 'REJECTED_DOUBLE_SPEND', err.message);
          audit.record({ eventType: 'DOUBLE_SPEND_DETECTED', userId, deviceId, transactionId });
          disputed.push({ transactionId, status: 'REJECTED_DOUBLE_SPEND', reason: err.message });
        } else {
          console.error('[sync] Settlement error txn=', transactionId, err);
          rejectTransaction(transactionId, 'DISPUTED', err.message);
          disputed.push({ transactionId, status: 'DISPUTED', reason: 'Settlement error — manual review required' });
        }
      }
    }

    audit.record({
      eventType: 'OFFLINE_SYNC_RECEIVED',
      userId,
      deviceId,
      payload: { count: pendingTransactions.length, settled: settlementResults.length, rejected: rejected.length },
    });

    // Return revocations for the device's user
    const revokedDevices = db.prepare(
      `SELECT DISTINCT device_id FROM device_keys WHERE user_id = ? AND status IN ('REVOKED','LOST')`
    ).all(userId);
    const revokedTokenIds = db.prepare(
      `SELECT token_id FROM offline_tokens WHERE owner_user_id = ? AND status = 'REVOKED'`
    ).all(userId);

    return res.json({
      serverTime,
      syncCursor,
      settlementResults,
      rejected,
      disputed,
      revokedTokenIds: revokedTokenIds.map((t) => t.token_id),
      revokedDeviceIds: revokedDevices.map((d) => d.device_id),
      newOfflineTokens: [],
    });
  } catch (err) { next(err); }
});

// GET /api/offline/sync/status/:transactionId
router.get('/status/:transactionId', requireAuth, (req, res, next) => {
  try {
    const { transactionId } = req.params;
    const { userId } = req.user;
    const db = getDb();

    const txn = db.prepare('SELECT * FROM offline_transactions WHERE transaction_id = ?').get(transactionId);
    if (!txn || (txn.sender_user_id !== userId && txn.receiver_user_id !== userId)) {
      return res.json({ transactionId, status: 'NOT_FOUND' });
    }

    return res.json({
      transactionId,
      status: txn.status,
      settledAt: txn.settled_at || null,
      rejectionReason: txn.rejection_reason || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
