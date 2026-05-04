'use strict';

const router = require('express').Router();
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

// GET /api/offline/limits
router.get('/', requireAuth, (req, res, next) => {
  try {
    const { userId } = req.user;
    const db = getDb();

    const issuedSum = db.prepare(
      `SELECT COALESCE(SUM(amount_minor),0) AS total FROM offline_tokens WHERE owner_user_id = ? AND status = 'ISSUED'`
    ).get(userId);
    const currentReserved = issuedSum.total;

    const unsyncedCount = db.prepare(
      `SELECT COUNT(*) AS cnt FROM offline_transactions WHERE sender_user_id = ? AND status = 'PENDING'`
    ).get(userId);

    return res.json({
      maxOfflineWalletMinor: config.OFFLINE_MAX_WALLET_MINOR,
      maxTransactionMinor: config.OFFLINE_MAX_TXN_MINOR,
      currentReservedMinor: currentReserved,
      remainingCapacityMinor: Math.max(0, config.OFFLINE_MAX_WALLET_MINOR - currentReserved),
      maxUnsyncedTransactions: config.OFFLINE_MAX_UNSYNCED_TXNS,
      currentUnsyncedTransactions: unsyncedCount.cnt,
      tokenExpiryDays: config.OFFLINE_TOKEN_EXPIRY_DAYS,
      serverTime: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
