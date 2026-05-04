'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

// Append-only audit log — never throws, never blocks the main flow
function record({ eventType, userId, deviceId, transactionId, tokenId, payload }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO offline_audit_events
        (audit_event_id, event_type, user_id, device_id, transaction_id, token_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      eventType,
      userId || null,
      deviceId || null,
      transactionId || null,
      tokenId || null,
      payload ? JSON.stringify(payload) : null,
    );
  } catch (err) {
    console.error(`[audit] Failed to write event type=${eventType}:`, err.message);
  }
}

module.exports = { record };
