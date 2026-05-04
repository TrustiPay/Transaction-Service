'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

let db;

function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

function initDb() {
  const dbPath = config.DB_PATH;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Serializable isolation for settlement transactions
  db.pragma('busy_timeout = 10000');

  createTables();
  console.log(`[db] SQLite database ready at ${dbPath}`);
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_keys (
      public_key_id   TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      device_id       TEXT NOT NULL,
      public_key      TEXT NOT NULL,
      algorithm       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      revoked_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dk_user   ON device_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_dk_device ON device_keys(device_id);
    CREATE INDEX IF NOT EXISTS idx_dk_status ON device_keys(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS server_signing_keys (
      server_key_id TEXT PRIMARY KEY,
      algorithm     TEXT NOT NULL,
      public_key    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      activated_at  TEXT,
      retired_at    TEXT,
      expires_at    TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS offline_tokens (
      token_id                TEXT PRIMARY KEY,
      owner_user_id           TEXT NOT NULL,
      owner_device_id         TEXT NOT NULL,
      amount_minor            INTEGER NOT NULL,
      currency                TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'ISSUED',
      issued_at               TEXT NOT NULL,
      expires_at              TEXT NOT NULL,
      server_key_id           TEXT NOT NULL,
      token_payload_canonical BLOB NOT NULL,
      server_signature        TEXT NOT NULL,
      spent_transaction_id    TEXT,
      spent_at                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ot_owner      ON offline_tokens(owner_user_id, owner_device_id);
    CREATE INDEX IF NOT EXISTS idx_ot_status     ON offline_tokens(status);
    CREATE INDEX IF NOT EXISTS idx_ot_expires_at ON offline_tokens(expires_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS offline_transactions (
      transaction_id    TEXT PRIMARY KEY,
      sender_user_id    TEXT,
      receiver_user_id  TEXT,
      sender_device_id  TEXT,
      receiver_device_id TEXT,
      amount_minor      INTEGER NOT NULL,
      currency          TEXT NOT NULL,
      status            TEXT NOT NULL,
      request_payload   BLOB,
      offer_payload     BLOB NOT NULL,
      receipt_payload   BLOB NOT NULL,
      transport_type    TEXT,
      created_at_device TEXT,
      received_at_server TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      settled_at        TEXT,
      rejection_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_otx_sender   ON offline_transactions(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_otx_receiver ON offline_transactions(receiver_user_id);
    CREATE INDEX IF NOT EXISTS idx_otx_status   ON offline_transactions(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS online_transactions (
      id                TEXT PRIMARY KEY,
      sender_user_id    TEXT NOT NULL,
      receiver_user_id  TEXT NOT NULL,
      sender_device_id  TEXT,
      amount_minor      INTEGER NOT NULL,
      currency          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'PENDING',
      request_hash      TEXT,
      idempotency_key   TEXT,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      settled_at        TEXT,
      rejection_reason  TEXT,
      fraud_decision    TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      ledger_entry_id TEXT PRIMARY KEY,
      wallet_id       TEXT NOT NULL,
      transaction_id  TEXT NOT NULL,
      entry_type      TEXT NOT NULL,
      amount_minor    INTEGER NOT NULL,
      currency        TEXT NOT NULL,
      direction       TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_le_wallet      ON ledger_entries(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_le_transaction ON ledger_entries(transaction_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_balances (
      user_id                  TEXT PRIMARY KEY,
      available_minor          INTEGER NOT NULL DEFAULT 0,
      offline_reserved_minor   INTEGER NOT NULL DEFAULT 0,
      currency                 TEXT NOT NULL DEFAULT 'LKR',
      updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idem_key      TEXT NOT NULL,
      endpoint      TEXT NOT NULL,
      user_id       TEXT,
      request_hash  TEXT NOT NULL,
      response_body TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      expires_at    TEXT NOT NULL,
      PRIMARY KEY (idem_key, endpoint)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS offline_audit_events (
      audit_event_id TEXT PRIMARY KEY,
      event_type     TEXT NOT NULL,
      user_id        TEXT,
      device_id      TEXT,
      transaction_id TEXT,
      token_id       TEXT,
      payload        TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
}

// Returns or creates a wallet row for user_id, initialising with default balance
function ensureWallet(userId) {
  const existing = db.prepare('SELECT * FROM wallet_balances WHERE user_id = ?').get(userId);
  if (existing) return existing;

  const stmt = db.prepare(`
    INSERT INTO wallet_balances (user_id, available_minor, offline_reserved_minor, currency)
    VALUES (?, ?, 0, ?)
  `);
  stmt.run(userId, config.DEFAULT_WALLET_BALANCE_MINOR, config.DEFAULT_WALLET_CURRENCY);
  return db.prepare('SELECT * FROM wallet_balances WHERE user_id = ?').get(userId);
}

module.exports = { initDb, getDb, ensureWallet };
