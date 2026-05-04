'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

// Attaches req.user = { userId, phoneNumber, deviceId } from Bearer JWT
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      errorCode: 'UNAUTHENTICATED',
      message: 'Missing or invalid Authorization header.',
      retryable: false,
      serverTime: new Date().toISOString(),
    });
  }

  const token = header.slice(7);
  try {
    const claims = jwt.verify(token, config.JWT_SECRET);
    req.user = {
      userId: claims.sub || claims.userId,
      phoneNumber: claims.phoneNumber || null,
      deviceId: claims.deviceId || null,
    };
    if (!req.user.userId) throw new Error('Missing userId claim');
    next();
  } catch (err) {
    return res.status(401).json({
      errorCode: 'UNAUTHENTICATED',
      message: 'JWT verification failed.',
      retryable: false,
      serverTime: new Date().toISOString(),
    });
  }
}

// Allows calls from internal services via X-Internal-Service header
function requireInternal(req, res, next) {
  const secret = req.headers['x-internal-service'];
  if (!config.INTERNAL_SERVICE_SECRET || secret !== config.INTERNAL_SERVICE_SECRET) {
    return res.status(403).json({
      errorCode: 'FORBIDDEN',
      message: 'Internal service secret missing or invalid.',
      retryable: false,
      serverTime: new Date().toISOString(),
    });
  }
  next();
}

module.exports = { requireAuth, requireInternal };
