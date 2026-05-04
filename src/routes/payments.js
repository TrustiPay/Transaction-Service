'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDb, ensureWallet } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const audit = require('../services/audit');

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

// POST /api/payments
router.post('/', requireAuth, idempotency, (req, res, next) => {
  try {
    const { receiverUserId, amountMinor, currency, deviceId, timestamp, requestHash, networkType, senderBank } = req.body;
    const { userId } = req.user;

    if (!receiverUserId || !amountMinor || !currency || !deviceId || !timestamp) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'receiverUserId, amountMinor, currency, deviceId, and timestamp are required.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // Timestamp freshness check
    const clientTime = new Date(timestamp).getTime();
    const serverNow = Date.now();
    if (Math.abs(serverNow - clientTime) > MAX_TIMESTAMP_SKEW_MS) {
      return res.status(400).json({
        errorCode: 'TIMESTAMP_SKEW',
        message: 'Request timestamp is too far from server time. Max skew is 5 minutes.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // Device binding check
    if (req.user.deviceId && deviceId !== req.user.deviceId) {
      return res.status(400).json({
        errorCode: 'DEVICE_ID_MISMATCH',
        message: 'deviceId in request body does not match authenticated device.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const db = getDb();
    const transactionId = uuidv4();
    const now = new Date().toISOString();

    // Check sender balance
    const senderWallet = ensureWallet(userId);
    if (senderWallet.available_minor < amountMinor) {
      return res.status(400).json({
        errorCode: 'INSUFFICIENT_AVAILABLE_BALANCE',
        message: 'Insufficient available balance.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // Process synchronously (no queue needed in single-container mode)
    const doSettle = db.transaction(() => {
      db.prepare(`
        INSERT INTO online_transactions
          (id, sender_user_id, receiver_user_id, sender_device_id, amount_minor, currency,
           status, request_hash, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `).run(transactionId, userId, receiverUserId, deviceId, amountMinor, currency, requestHash || null, req.headers['idempotency-key'] || null);

      // Debit sender
      db.prepare(`UPDATE wallet_balances SET available_minor = available_minor - ?, updated_at = ? WHERE user_id = ?`)
        .run(amountMinor, now, userId);

      // Credit receiver
      ensureWallet(receiverUserId);
      db.prepare(`UPDATE wallet_balances SET available_minor = available_minor + ?, updated_at = ? WHERE user_id = ?`)
        .run(amountMinor, now, receiverUserId);

      // Ledger entries
      db.prepare(`INSERT INTO ledger_entries (ledger_entry_id, wallet_id, transaction_id, entry_type, amount_minor, currency, direction) VALUES (?, ?, ?, 'DEBIT_ONLINE_PAYMENT', ?, ?, 'DEBIT')`)
        .run(uuidv4(), userId, transactionId, amountMinor, currency);
      db.prepare(`INSERT INTO ledger_entries (ledger_entry_id, wallet_id, transaction_id, entry_type, amount_minor, currency, direction) VALUES (?, ?, ?, 'CREDIT_ONLINE_PAYMENT', ?, ?, 'CREDIT')`)
        .run(uuidv4(), receiverUserId, transactionId, amountMinor, currency);

      // Mark settled
      db.prepare(`UPDATE online_transactions SET status = 'SETTLED', settled_at = ? WHERE id = ?`).run(now, transactionId);
    });

    doSettle();

    audit.record({ eventType: 'ONLINE_PAYMENT_SETTLED', userId, transactionId, payload: { amountMinor, receiverUserId } });

    return res.json({ transactionId, status: 'SETTLED', serverTime: now });
  } catch (err) { next(err); }
});

// GET /api/payments/:transactionId/status
router.get('/:transactionId/status', requireAuth, (req, res, next) => {
  try {
    const { transactionId } = req.params;
    const { userId } = req.user;
    const db = getDb();

    const txn = db.prepare('SELECT * FROM online_transactions WHERE id = ?').get(transactionId);
    if (!txn || txn.sender_user_id !== userId) {
      return res.status(404).json({
        errorCode: 'TRANSACTION_NOT_FOUND',
        message: 'Transaction not found.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    return res.json({
      transactionId: txn.id,
      status: txn.status,
      amountMinor: txn.amount_minor,
      currency: txn.currency,
      createdAt: txn.created_at,
      settledAt: txn.settled_at || null,
      rejectionReason: txn.rejection_reason || null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
