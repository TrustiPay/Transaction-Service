'use strict';

const crypto = require('crypto');
const { getDb, ensureWallet } = require('../db');
const { verify: verifyServerSig } = require('../crypto/tokenSigner');
const { v4: uuidv4 } = require('uuid');
const audit = require('./audit');
const config = require('../config');

const SUPPORTED_PROTOCOL_VERSIONS = ['1.0'];

// ---------------------------------------------------------------------------
// Validation — does not write anything, returns { valid, rejectionStatus, rejectionReason }
// ---------------------------------------------------------------------------
function validate(item) {
  const db = getDb();

  // Step 1: Parse payloads
  let offer, receipt, request;
  try {
    offer   = JSON.parse(Buffer.from(item.paymentOffer, 'base64url').toString());
    receipt = JSON.parse(Buffer.from(item.paymentReceipt, 'base64url').toString());
    request = item.paymentRequest
      ? JSON.parse(Buffer.from(item.paymentRequest, 'base64url').toString())
      : null;
  } catch {
    return fail('REJECTED_INVALID_SIGNATURE', 'Malformed payload encoding');
  }

  // Step 2: Protocol version
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(offer.protocolVersion)) {
    return fail('REJECTED_PROTOCOL_VERSION', `Unsupported protocol version: ${offer.protocolVersion}`);
  }

  const offerBytes   = Buffer.from(item.paymentOffer, 'base64url');
  const receiptBytes = Buffer.from(item.paymentReceipt, 'base64url');

  // Steps 4–9: Token validation (pre-check without lock — definitive check inside settle())
  const placeholders = item.spentTokenIds.map(() => '?').join(',');
  const tokens = db.prepare(
    `SELECT * FROM offline_tokens WHERE token_id IN (${placeholders})`
  ).all(...item.spentTokenIds);

  // Step 5: All tokens must exist
  if (tokens.length !== item.spentTokenIds.length) {
    return fail('REJECTED_INVALID_SIGNATURE', 'One or more tokens not found in server database');
  }

  for (const token of tokens) {
    // Step 4: Verify server signature on token
    if (!verifyServerSig(Buffer.from(token.token_payload_canonical), token.server_signature)) {
      return fail('REJECTED_INVALID_SIGNATURE', `Invalid server signature on token ${token.token_id}`);
    }
    // Step 6: Ownership by user
    if (token.owner_user_id !== item.senderUserId) {
      return fail('REJECTED_INVALID_SIGNATURE', `Token ${token.token_id} does not belong to sender`);
    }
    // Step 7: Ownership by device
    if (token.owner_device_id !== item.senderDeviceId) {
      return fail('REJECTED_INVALID_SIGNATURE', `Token ${token.token_id} does not belong to sender device`);
    }
    // Step 8: Expiry
    if (new Date(token.expires_at) <= new Date()) {
      return fail('REJECTED_TOKEN_EXPIRED', `Token ${token.token_id} has expired`);
    }
    // Step 9: Status pre-check
    if (token.status === 'REVOKED')  return fail('REJECTED_TOKEN_REVOKED',  `Token ${token.token_id} has been revoked`);
    if (token.status === 'SPENT')    return fail('REJECTED_DOUBLE_SPEND',   `Token ${token.token_id} was already spent`);
    if (token.status !== 'ISSUED')   return fail('REJECTED_INVALID_SIGNATURE', `Token ${token.token_id} unexpected status: ${token.status}`);
  }

  // Steps 10–11: Device key lookup
  const senderKey = db.prepare(
    `SELECT * FROM device_keys WHERE user_id = ? AND device_id = ? AND status = 'ACTIVE' LIMIT 1`
  ).get(item.senderUserId, item.senderDeviceId);
  if (!senderKey) return fail('REJECTED_DEVICE_REVOKED', 'Sender device is not active');

  const receiverKey = db.prepare(
    `SELECT * FROM device_keys WHERE user_id = ? AND device_id = ? AND status = 'ACTIVE' LIMIT 1`
  ).get(item.receiverUserId, item.receiverDeviceId);
  if (!receiverKey) return fail('REJECTED_DEVICE_REVOKED', 'Receiver device is not active');

  // Steps 12–13: Device signature verification
  if (!verifyDeviceSig(offerBytes, offer.senderSignature, senderKey.public_key)) {
    return fail('REJECTED_INVALID_SIGNATURE', 'Invalid sender signature on PaymentOffer');
  }
  if (!verifyDeviceSig(receiptBytes, receipt.receiverSignature, receiverKey.public_key)) {
    return fail('REJECTED_INVALID_SIGNATURE', 'Invalid receiver signature on PaymentReceipt');
  }

  // Step 14: PaymentOffer.requestHash must equal SHA256(PaymentRequest)
  if (request && offer.requestHash) {
    const requestBytes = Buffer.from(item.paymentRequest, 'base64url');
    const expectedRequestHash = crypto.createHash('sha256').update(requestBytes).digest('hex');
    if (offer.requestHash !== expectedRequestHash) {
      return fail('REJECTED_INVALID_SIGNATURE', 'PaymentOffer.requestHash does not match hash of PaymentRequest');
    }
  }

  // Step 15: PaymentReceipt.offerHash must equal SHA256(PaymentOffer)
  if (receipt.offerHash) {
    const expectedOfferHash = crypto.createHash('sha256').update(offerBytes).digest('hex');
    if (receipt.offerHash !== expectedOfferHash) {
      return fail('REJECTED_INVALID_SIGNATURE', 'PaymentReceipt.offerHash does not match hash of PaymentOffer');
    }
  }

  // Step 16: Amount and currency consistency
  if (offer.amountMinor !== item.amountMinor) {
    return fail('REJECTED_AMOUNT_MISMATCH', `Amount mismatch: offer=${offer.amountMinor} item=${item.amountMinor}`);
  }
  if (offer.currency !== item.currency) {
    return fail('REJECTED_CURRENCY_MISMATCH', 'Currency mismatch');
  }

  // Step 17: Token amounts sum to payment amount
  const tokenSum = tokens.reduce((acc, t) => acc + t.amount_minor, 0);
  if (tokenSum !== item.amountMinor) {
    return fail('REJECTED_AMOUNT_MISMATCH', `Token sum ${tokenSum} != payment amount ${item.amountMinor}`);
  }

  // Step 18: Idempotency — already SETTLED is not an error
  const existing = db.prepare('SELECT status FROM offline_transactions WHERE transaction_id = ?').get(item.transactionId);
  if (existing && existing.status === 'SETTLED') {
    return { valid: true, alreadySettled: true };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Atomic settlement — must be called only after validate() returns { valid: true }
// better-sqlite3 transactions are synchronous and serialised within the process,
// preventing double-spend race conditions without needing SELECT … FOR UPDATE.
// ---------------------------------------------------------------------------
function settle(item) {
  const db = getDb();

  // Shadow mode — validate but do not write ledger entries
  if (config.OFFLINE_SETTLEMENT_MODE === 'shadow') {
    console.log(`[settlement] SHADOW settle txn=${item.transactionId} amount=${item.amountMinor}`);
    return;
  }

  const doSettle = db.transaction(() => {
    const placeholders = item.spentTokenIds.map(() => '?').join(',');

    // Re-check status inside the transaction (authoritative double-spend check)
    const tokens = db.prepare(
      `SELECT token_id, status FROM offline_tokens WHERE token_id IN (${placeholders})`
    ).all(...item.spentTokenIds);

    const notIssued = tokens.filter((t) => t.status !== 'ISSUED');
    if (notIssued.length > 0) {
      const err = new Error('REJECTED_DOUBLE_SPEND');
      err.errorBody = {
        errorCode: 'REJECTED_DOUBLE_SPEND',
        message: `Token(s) already spent: ${notIssued.map((t) => t.token_id).join(', ')}`,
        transactionId: item.transactionId,
        retryable: false,
        serverTime: new Date().toISOString(),
      };
      throw err;
    }

    const now = new Date().toISOString();

    // Mark tokens SPENT
    db.prepare(
      `UPDATE offline_tokens
         SET status = 'SPENT', spent_transaction_id = ?, spent_at = ?
       WHERE token_id IN (${placeholders})`
    ).run(item.transactionId, now, ...item.spentTokenIds);

    // Write offline transaction record (INSERT OR IGNORE for idempotency)
    db.prepare(`
      INSERT OR IGNORE INTO offline_transactions
        (transaction_id, sender_user_id, receiver_user_id, sender_device_id, receiver_device_id,
         amount_minor, currency, status, offer_payload, receipt_payload, request_payload,
         transport_type, created_at_device, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'SETTLED', ?, ?, ?, ?, ?, ?)
    `).run(
      item.transactionId,
      item.senderUserId,
      item.receiverUserId,
      item.senderDeviceId,
      item.receiverDeviceId,
      item.amountMinor,
      item.currency,
      Buffer.from(item.paymentOffer, 'base64url'),
      Buffer.from(item.paymentReceipt, 'base64url'),
      item.paymentRequest ? Buffer.from(item.paymentRequest, 'base64url') : null,
      item.transportType || 'UNKNOWN',
      item.createdAtDevice || null,
      now,
    );
    // Update if it already existed as PENDING
    db.prepare(
      `UPDATE offline_transactions SET status = 'SETTLED', settled_at = ? WHERE transaction_id = ? AND status != 'SETTLED'`
    ).run(now, item.transactionId);

    // Ledger: move sender offline_reserved_minor → receiver available_minor
    const senderWallet   = ensureWallet(item.senderUserId);
    const receiverWallet = ensureWallet(item.receiverUserId);

    // Sender: debit offline_reserved_minor
    db.prepare(`
      UPDATE wallet_balances
         SET offline_reserved_minor = MAX(0, offline_reserved_minor - ?), updated_at = ?
       WHERE user_id = ?
    `).run(item.amountMinor, now, item.senderUserId);

    // Receiver: credit available_minor
    db.prepare(`
      UPDATE wallet_balances
         SET available_minor = available_minor + ?, updated_at = ?
       WHERE user_id = ?
    `).run(item.amountMinor, now, item.receiverUserId);

    // Append-only ledger entries
    db.prepare(`
      INSERT INTO ledger_entries (ledger_entry_id, wallet_id, transaction_id, entry_type, amount_minor, currency, direction)
      VALUES (?, ?, ?, 'DEBIT_OFFLINE_SETTLEMENT', ?, ?, 'DEBIT')
    `).run(uuidv4(), item.senderUserId, item.transactionId, item.amountMinor, item.currency);

    db.prepare(`
      INSERT INTO ledger_entries (ledger_entry_id, wallet_id, transaction_id, entry_type, amount_minor, currency, direction)
      VALUES (?, ?, ?, 'CREDIT_OFFLINE_SETTLEMENT', ?, ?, 'CREDIT')
    `).run(uuidv4(), item.receiverUserId, item.transactionId, item.amountMinor, item.currency);
  });

  doSettle();

  audit.record({
    eventType: 'OFFLINE_SETTLED',
    userId: item.senderUserId,
    transactionId: item.transactionId,
    payload: { amountMinor: item.amountMinor, receiverUserId: item.receiverUserId },
  });

  console.log(`[settlement] Settled txn=${item.transactionId} amount=${item.amountMinor} sender=${item.senderUserId}`);
}

function rejectTransaction(transactionId, status, reason) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE offline_transactions
       SET status = ?, rejection_reason = ?
     WHERE transaction_id = ? AND status = 'PENDING'
  `).run(status, reason, transactionId);
  console.log(`[settlement] Rejected txn=${transactionId} status=${status}`);
}

function verifyDeviceSig(payload, signatureBase64url, publicKeyBase64) {
  if (!signatureBase64url) return false;
  try {
    const pub = crypto.createPublicKey(Buffer.from(publicKeyBase64, 'base64'));
    const verifier = crypto.createVerify('SHA256');
    verifier.update(payload);
    return verifier.verify(pub, Buffer.from(signatureBase64url, 'base64url'));
  } catch {
    return false;
  }
}

function fail(status, reason) {
  return { valid: false, rejectionStatus: status, rejectionReason: reason };
}

module.exports = { validate, settle, rejectTransaction };
