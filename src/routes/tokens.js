'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, ensureWallet } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { sign, getKeyId, getAlgorithm, getPublicKeyBase64 } = require('../crypto/tokenSigner');
const audit = require('../services/audit');
const config = require('../config');

// LKR denominations in minor units (1 LKR = 100 minor)
const VALID_DENOMINATIONS = [1000, 2000, 5000, 10000, 50000, 100000];

// GET /api/offline/server-keys
router.get('/server-keys', (req, res, next) => {
  try {
    const db = getDb();
    const dbKeys = db.prepare(`SELECT * FROM server_signing_keys WHERE status = 'ACTIVE'`).all();

    const signerKey = {
      serverKeyId: getKeyId(),
      algorithm: getAlgorithm(),
      publicKey: getPublicKeyBase64(),
      status: 'ACTIVE',
    };

    const keys = dbKeys.length > 0
      ? dbKeys.map((k) => ({ serverKeyId: k.server_key_id, algorithm: k.algorithm, publicKey: k.public_key, status: k.status }))
      : [signerKey];

    return res.json({ keys, serverTime: new Date().toISOString() });
  } catch (err) { next(err); }
});

// POST /api/offline/tokens/request
router.post('/request', requireAuth, idempotency, (req, res, next) => {
  try {
    if (!config.OFFLINE_PAYMENTS_ENABLED) {
      return res.status(403).json({
        errorCode: 'OFFLINE_DISABLED',
        message: 'Offline payments are not enabled.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const { deviceId, requestedAmountMinor, currency } = req.body;
    const { userId } = req.user;

    if (!deviceId || !requestedAmountMinor || !currency) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'deviceId, requestedAmountMinor, and currency are required.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }
    if (typeof requestedAmountMinor !== 'number' || requestedAmountMinor <= 0) {
      return res.status(400).json({
        errorCode: 'VALIDATION_ERROR',
        message: 'requestedAmountMinor must be a positive integer.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }
    if (requestedAmountMinor > config.OFFLINE_MAX_TXN_MINOR) {
      return res.status(400).json({
        errorCode: 'TOKEN_ISSUANCE_LIMIT_EXCEEDED',
        message: `Requested amount exceeds max single request limit of ${config.OFFLINE_MAX_TXN_MINOR} minor units.`,
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    const db = getDb();

    // Device must be ACTIVE
    const deviceKey = db.prepare(
      `SELECT * FROM device_keys WHERE user_id = ? AND device_id = ? AND status = 'ACTIVE' LIMIT 1`
    ).get(userId, deviceId);
    if (!deviceKey) {
      return res.status(400).json({
        errorCode: 'DEVICE_NOT_REGISTERED',
        message: 'Device is not registered or not active.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // Check offline wallet cap
    const issuedSum = db.prepare(
      `SELECT COALESCE(SUM(amount_minor),0) AS total FROM offline_tokens WHERE owner_user_id = ? AND status = 'ISSUED'`
    ).get(userId);
    const currentReserved = issuedSum.total;
    if (currentReserved + requestedAmountMinor > config.OFFLINE_MAX_WALLET_MINOR) {
      return res.status(400).json({
        errorCode: 'TOKEN_ISSUANCE_LIMIT_EXCEEDED',
        message: `Offline wallet limit of ${config.OFFLINE_MAX_WALLET_MINOR} minor units would be exceeded.`,
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // No unresolved disputes
    const disputes = db.prepare(
      `SELECT COUNT(*) AS cnt FROM offline_transactions WHERE sender_user_id = ? AND status = 'DISPUTED'`
    ).get(userId);
    if (disputes.cnt > 0) {
      return res.status(403).json({
        errorCode: 'UNRESOLVED_DISPUTE',
        message: 'Account has unresolved offline transaction disputes. Offline token issuance is suspended.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // Check available wallet balance
    const wallet = ensureWallet(userId);
    if (wallet.available_minor < requestedAmountMinor) {
      return res.status(400).json({
        errorCode: 'INSUFFICIENT_AVAILABLE_BALANCE',
        message: 'Insufficient available balance to issue offline tokens.',
        retryable: false,
        serverTime: new Date().toISOString(),
      });
    }

    // Build token denominations
    const denominations = buildDenominations(requestedAmountMinor);
    const totalMinor = denominations.reduce((a, b) => a + b, 0);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.OFFLINE_TOKEN_EXPIRY_DAYS * 86400_000);
    const issuedAt = now.toISOString();
    const expiresAtStr = expiresAt.toISOString();
    const keyId = getKeyId();

    const issueTokens = db.transaction(() => {
      // Reserve balance
      db.prepare(`
        UPDATE wallet_balances
           SET available_minor = available_minor - ?,
               offline_reserved_minor = offline_reserved_minor + ?,
               updated_at = ?
         WHERE user_id = ?
      `).run(totalMinor, totalMinor, issuedAt, userId);

      const tokenResults = [];

      for (const denom of denominations) {
        const tokenId = `tok_${uuidv4().replace(/-/g, '')}`;
        const nonce = crypto.randomBytes(32).toString('base64url');

        const payload = {
          tokenId,
          ownerUserId: userId,
          ownerDeviceId: deviceId,
          amountMinor: denom,
          currency,
          issuedAt,
          expiresAt: expiresAtStr,
          issuerKeyId: keyId,
          nonce,
          protocolVersion: '1.0',
        };

        const { serverSignature, canonicalBytes } = sign(payload);

        db.prepare(`
          INSERT INTO offline_tokens
            (token_id, owner_user_id, owner_device_id, amount_minor, currency, status,
             issued_at, expires_at, server_key_id, token_payload_canonical, server_signature)
          VALUES (?, ?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?, ?)
        `).run(tokenId, userId, deviceId, denom, currency, issuedAt, expiresAtStr, keyId, canonicalBytes, serverSignature);

        tokenResults.push({ tokenId, amountMinor: denom, currency, issuedAt, expiresAt: expiresAtStr, serverKeyId: keyId, serverSignature, nonce, protocolVersion: '1.0' });
      }

      return tokenResults;
    });

    const tokens = issueTokens();

    for (const t of tokens) {
      audit.record({ eventType: 'TOKEN_ISSUED', userId, deviceId, tokenId: t.tokenId, payload: { amountMinor: t.amountMinor, expiresAt: t.expiresAt } });
    }

    console.log(`[tokens] Issued ${tokens.length} tokens totalMinor=${totalMinor} userId=${userId}`);

    return res.json({ reservedAmountMinor: totalMinor, expiresAt: expiresAtStr, tokens });
  } catch (err) { next(err); }
});

// POST /api/offline/tokens/refresh — alias for request
router.post('/refresh', requireAuth, idempotency, (req, res, next) => {
  req.url = '/request';
  next('route');
});

function buildDenominations(requestedMinor) {
  const denoms = [...VALID_DENOMINATIONS].sort((a, b) => b - a);
  const result = [];
  let remaining = requestedMinor;
  for (const d of denoms) {
    while (remaining >= d) { result.push(d); remaining -= d; }
  }
  if (remaining > 0 && denoms.length > 0) result.push(denoms[denoms.length - 1]);
  return result;
}

module.exports = router;
