'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { getDb, ensureWallet } = require('../db');
const { requireInternal } = require('../middleware/auth');
const audit = require('../services/audit');
const { expireUnusedTokens, cleanupIdempotencyKeys } = require('../services/jobs');

// All admin routes require X-Internal-Service header

// POST /api/admin/wallets/topup  — add balance to a test wallet
router.post('/wallets/topup', requireInternal, (req, res, next) => {
  try {
    const { userId, amountMinor, currency } = req.body;
    if (!userId || !amountMinor) {
      return res.status(400).json({ error: 'userId and amountMinor required' });
    }

    const db = getDb();
    ensureWallet(userId);
    const now = new Date().toISOString();

    const tid = `topup_${uuidv4().replace(/-/g, '')}`;
    db.prepare(`UPDATE wallet_balances SET available_minor = available_minor + ?, updated_at = ? WHERE user_id = ?`)
      .run(amountMinor, now, userId);

    db.prepare(`INSERT INTO ledger_entries (ledger_entry_id, wallet_id, transaction_id, entry_type, amount_minor, currency, direction) VALUES (?, ?, ?, 'CREDIT_ADMIN_TOPUP', ?, ?, 'CREDIT')`)
      .run(uuidv4(), userId, tid, amountMinor, currency || 'LKR');

    const wallet = db.prepare('SELECT * FROM wallet_balances WHERE user_id = ?').get(userId);
    return res.json({ userId, availableMinor: wallet.available_minor, offlineReservedMinor: wallet.offline_reserved_minor });
  } catch (err) { next(err); }
});

// GET /api/admin/wallets/:userId
router.get('/wallets/:userId', requireInternal, (req, res, next) => {
  try {
    const db = getDb();
    const wallet = ensureWallet(req.params.userId);
    return res.json(wallet);
  } catch (err) { next(err); }
});

// GET /api/admin/tokens — search offline tokens
router.get('/tokens', requireInternal, (req, res, next) => {
  try {
    const { userId, status, limit = 50 } = req.query;
    const db = getDb();

    let sql = 'SELECT token_id, owner_user_id, owner_device_id, amount_minor, currency, status, issued_at, expires_at, server_key_id, spent_transaction_id, spent_at FROM offline_tokens WHERE 1=1';
    const params = [];
    if (userId) { sql += ' AND owner_user_id = ?'; params.push(userId); }
    if (status)  { sql += ' AND status = ?'; params.push(status); }
    sql += ` ORDER BY issued_at DESC LIMIT ?`;
    params.push(parseInt(limit, 10));

    const tokens = db.prepare(sql).all(...params);
    return res.json({ tokens, count: tokens.length });
  } catch (err) { next(err); }
});

// GET /api/admin/transactions — search offline transactions
router.get('/transactions', requireInternal, (req, res, next) => {
  try {
    const { userId, status, limit = 50 } = req.query;
    const db = getDb();

    let sql = 'SELECT transaction_id, sender_user_id, receiver_user_id, amount_minor, currency, status, transport_type, received_at_server, settled_at, rejection_reason FROM offline_transactions WHERE 1=1';
    const params = [];
    if (userId) { sql += ' AND (sender_user_id = ? OR receiver_user_id = ?)'; params.push(userId, userId); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ` ORDER BY received_at_server DESC LIMIT ?`;
    params.push(parseInt(limit, 10));

    const txns = db.prepare(sql).all(...params);
    return res.json({ transactions: txns, count: txns.length });
  } catch (err) { next(err); }
});

// GET /api/admin/audit — recent audit events
router.get('/audit', requireInternal, (req, res, next) => {
  try {
    const { userId, eventType, limit = 100 } = req.query;
    const db = getDb();

    let sql = 'SELECT * FROM offline_audit_events WHERE 1=1';
    const params = [];
    if (userId)    { sql += ' AND user_id = ?'; params.push(userId); }
    if (eventType) { sql += ' AND event_type = ?'; params.push(eventType); }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(parseInt(limit, 10));

    const events = db.prepare(sql).all(...params);
    return res.json({ events, count: events.length });
  } catch (err) { next(err); }
});

// GET /api/admin/metrics
router.get('/metrics', requireInternal, (req, res, next) => {
  try {
    const db = getDb();
    const q = (sql, ...p) => db.prepare(sql).get(...p);

    return res.json({
      offlineTokensIssued:    q(`SELECT COUNT(*) AS n FROM offline_tokens WHERE status = 'ISSUED'`).n,
      offlineTokensSpent:     q(`SELECT COUNT(*) AS n FROM offline_tokens WHERE status = 'SPENT'`).n,
      offlineTokensExpired:   q(`SELECT COUNT(*) AS n FROM offline_tokens WHERE status = 'EXPIRED'`).n,
      offlineTokensRevoked:   q(`SELECT COUNT(*) AS n FROM offline_tokens WHERE status = 'REVOKED'`).n,
      offlineTxnsPending:     q(`SELECT COUNT(*) AS n FROM offline_transactions WHERE status = 'PENDING'`).n,
      offlineTxnsSettled:     q(`SELECT COUNT(*) AS n FROM offline_transactions WHERE status = 'SETTLED'`).n,
      offlineTxnsRejected:    q(`SELECT COUNT(*) AS n FROM offline_transactions WHERE status LIKE 'REJECTED%'`).n,
      offlineTxnsDisputed:    q(`SELECT COUNT(*) AS n FROM offline_transactions WHERE status = 'DISPUTED'`).n,
      onlineTxnsSettled:      q(`SELECT COUNT(*) AS n FROM online_transactions WHERE status = 'SETTLED'`).n,
      doubleSpendAttempts:    q(`SELECT COUNT(*) AS n FROM offline_audit_events WHERE event_type = 'DOUBLE_SPEND_DETECTED'`).n,
      registeredDevices:      q(`SELECT COUNT(*) AS n FROM device_keys WHERE status = 'ACTIVE'`).n,
      serverTime:             new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/jobs/expire-tokens — trigger token expiry manually
router.post('/jobs/expire-tokens', requireInternal, (req, res, next) => {
  try {
    expireUnusedTokens();
    return res.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (err) { next(err); }
});

// POST /api/admin/jobs/cleanup-idempotency
router.post('/jobs/cleanup-idempotency', requireInternal, (req, res, next) => {
  try {
    cleanupIdempotencyKeys();
    return res.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (err) { next(err); }
});

// POST /api/admin/devices/revoke — admin-initiated device revocation
router.post('/devices/revoke', requireInternal, (req, res, next) => {
  try {
    const { userId, deviceId, reason } = req.body;
    if (!userId || !deviceId) return res.status(400).json({ error: 'userId and deviceId required' });

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`UPDATE device_keys SET status = 'REVOKED', revoked_at = ? WHERE user_id = ? AND device_id = ?`)
      .run(now, userId, deviceId);

    audit.record({ eventType: 'DEVICE_REVOKED', userId, deviceId, payload: { reason: reason || 'ADMIN', source: 'admin' } });
    return res.json({ ok: true, userId, deviceId, serverTime: now });
  } catch (err) { next(err); }
});

module.exports = router;
