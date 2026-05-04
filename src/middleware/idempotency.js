'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

// Idempotency middleware — stores and replays responses keyed by (Idempotency-Key, endpoint, userId)
// Must be placed after requireAuth so req.user is available
function idempotency(req, res, next) {
  const idemKey = req.headers['idempotency-key'];
  if (!idemKey) return next(); // idempotency is optional on GET routes

  const endpoint = req.path;
  const userId = req.user ? req.user.userId : null;
  const requestHash = req.bodyHash || '';

  const db = getDb();
  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE idem_key = ? AND endpoint = ?').get(idemKey, endpoint);

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return res.status(422).json({
        errorCode: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key reused with a different request body.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }
    if (existing.response_body) {
      return res.status(200).json(JSON.parse(existing.response_body));
    }
    // Still processing (response_body is null) — return 202
    return res.status(202).json({ status: 'PROCESSING', serverTime: new Date().toISOString() });
  }

  // Register the key so concurrent duplicate requests see PROCESSING
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO idempotency_keys (idem_key, endpoint, user_id, request_hash, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(idemKey, endpoint, userId, requestHash, expiresAt);
  } catch {
    // Race condition — another request registered first; let this one proceed
  }

  // Intercept res.json to store the response
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        db.prepare('UPDATE idempotency_keys SET response_body = ? WHERE idem_key = ? AND endpoint = ?')
          .run(JSON.stringify(body), idemKey, endpoint);
      } catch { /* ignore */ }
    }
    return origJson(body);
  };

  next();
}

module.exports = { idempotency };
