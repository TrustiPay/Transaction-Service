'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let privateKey = null;
let publicKeyPem = '';
let keyId = config.SERVER_SIGNING_KEY_ID;

const algorithm = 'ECDSA_P256';

// Sorted-key canonical JSON — both server and app must use the same encoding
function canonicalize(obj) {
  if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(',')}}`;
}

async function initSigner() {
  const explicitPath = config.SERVER_SIGNING_PRIVATE_KEY_PATH;
  const autoPath = path.join(path.dirname(config.DB_PATH), 'server_signing_key.pem');
  const keyPath = explicitPath || autoPath;

  if (fs.existsSync(keyPath)) {
    const pem = fs.readFileSync(keyPath, 'utf8');
    privateKey = crypto.createPrivateKey(pem);
    publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
    console.log(`[signer] Loaded signing key from ${keyPath} keyId=${keyId}`);
  } else {
    console.warn('[signer] No key file found — generating ephemeral ECDSA P-256 key and persisting to', keyPath);
    const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = priv;
    publicKeyPem = pub.export({ type: 'spki', format: 'pem' });

    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`[signer] Generated and saved new signing key to ${keyPath}`);
  }

  // Upsert key record into server_signing_keys
  const { getDb } = require('../db');
  const db = getDb();
  const existing = db.prepare('SELECT server_key_id FROM server_signing_keys WHERE server_key_id = ?').get(keyId);
  if (!existing) {
    db.prepare(`
      INSERT INTO server_signing_keys (server_key_id, algorithm, public_key, status, activated_at)
      VALUES (?, ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    `).run(keyId, algorithm, Buffer.from(publicKeyPem).toString('base64'));
  }
}

function sign(payload) {
  if (!privateKey) throw new Error('Signer not initialized');
  const canonical = canonicalize(payload);
  const canonicalBytes = Buffer.from(canonical, 'utf8');
  const signer = crypto.createSign('SHA256');
  signer.update(canonicalBytes);
  const serverSignature = signer.sign(privateKey).toString('base64url');
  return { serverSignature, canonicalBytes };
}

function verify(canonicalBytes, signatureBase64url) {
  try {
    const pub = crypto.createPublicKey(publicKeyPem);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(canonicalBytes);
    return verifier.verify(pub, Buffer.from(signatureBase64url, 'base64url'));
  } catch {
    return false;
  }
}

function getPublicKeyBase64() {
  return Buffer.from(publicKeyPem).toString('base64');
}

function getKeyId() {
  return keyId;
}

function getAlgorithm() {
  return algorithm;
}

module.exports = { initSigner, sign, verify, getPublicKeyBase64, getKeyId, getAlgorithm, canonicalize };
