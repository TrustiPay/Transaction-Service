'use strict';

const cron = require('node-cron');
const { getDb, ensureWallet } = require('../db');
const audit = require('./audit');
const { v4: uuidv4 } = require('uuid');

// Runs every hour — expire ISSUED tokens past expiresAt and release reserved balance
function expireUnusedTokens() {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db.prepare(
    `SELECT * FROM offline_tokens WHERE status = 'ISSUED' AND expires_at < ? LIMIT 500`
  ).all(now);

  if (expired.length === 0) return;

  console.log(`[jobs] Expiring ${expired.length} unused offline tokens`);

  const doExpire = db.transaction(() => {
    for (const token of expired) {
      db.prepare(`UPDATE offline_tokens SET status = 'EXPIRED' WHERE token_id = ?`).run(token.token_id);

      // Release reserved balance
      ensureWallet(token.owner_user_id);
      db.prepare(`
        UPDATE wallet_balances
           SET offline_reserved_minor = MAX(0, offline_reserved_minor - ?), updated_at = ?
         WHERE user_id = ?
      `).run(token.amount_minor, now, token.owner_user_id);

      // Ledger entry
      db.prepare(`
        INSERT INTO ledger_entries
          (ledger_entry_id, wallet_id, transaction_id, entry_type, amount_minor, currency, direction)
        VALUES (?, ?, ?, 'CREDIT_OFFLINE_EXPIRY', ?, ?, 'CREDIT')
      `).run(uuidv4(), token.owner_user_id, `expiry-${token.token_id}`, token.amount_minor, token.currency);
    }
  });

  doExpire();

  for (const token of expired) {
    audit.record({
      eventType: 'TOKEN_EXPIRED',
      userId: token.owner_user_id,
      deviceId: token.owner_device_id,
      tokenId: token.token_id,
      payload: { amountMinor: token.amount_minor, expiresAt: token.expires_at },
    });
  }

  console.log(`[jobs] Token expiry complete — expired ${expired.length} tokens`);
}

// Runs daily at 02:00 — remove expired idempotency records
function cleanupIdempotencyKeys() {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`DELETE FROM idempotency_keys WHERE expires_at < ?`).run(now);
  if (result.changes > 0) {
    console.log(`[jobs] Idempotency cleanup: deleted ${result.changes} expired keys`);
  }
}

function startJobs() {
  // Every hour
  cron.schedule('0 * * * *', () => {
    try { expireUnusedTokens(); } catch (err) { console.error('[jobs] expireUnusedTokens error:', err); }
  });

  // Daily at 02:00
  cron.schedule('0 2 * * *', () => {
    try { cleanupIdempotencyKeys(); } catch (err) { console.error('[jobs] cleanupIdempotencyKeys error:', err); }
  });

  console.log('[jobs] Background jobs scheduled');
}

module.exports = { startJobs, expireUnusedTokens, cleanupIdempotencyKeys };
