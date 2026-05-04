'use strict';

const express = require('express');
const app = express();

app.use(express.json({ limit: '2mb' }));

// Compute and attach raw body hash for request integrity checks
app.use((req, _res, next) => {
  if (req.body && Object.keys(req.body).length > 0) {
    const crypto = require('crypto');
    req.bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body))
      .digest('hex');
  }
  next();
});

// Structured request logging
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

app.use('/health', require('./routes/health'));
app.use('/api/offline/devices', require('./routes/devices'));
app.use('/api/offline/tokens', require('./routes/tokens'));
app.use('/api/offline/sync', require('./routes/sync'));
app.use('/api/offline/revocations', require('./routes/revocations'));
app.use('/api/offline/limits', require('./routes/limits'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));

// Global error handler — never exposes internals
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const body = err.errorBody || {
    errorCode: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
    message: status === 500 ? 'An unexpected error occurred.' : err.message,
    retryable: status === 500,
    serverTime: new Date().toISOString(),
  };
  if (status === 500) {
    console.error('[error]', err);
  }
  res.status(status).json(body);
});

module.exports = app;
