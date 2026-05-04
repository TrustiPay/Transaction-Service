'use strict';

require('dotenv').config();

const config = {
  PORT: parseInt(process.env.PORT || '3001', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',

  DB_PATH: process.env.DB_PATH || './data/transactions.db',

  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-do-not-use-in-production',
  INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET || '',

  FRAUD_DETECTION_URL: process.env.FRAUD_DETECTION_URL || '',

  OFFLINE_PAYMENTS_ENABLED: process.env.OFFLINE_PAYMENTS_ENABLED === 'true',
  OFFLINE_SETTLEMENT_MODE: process.env.OFFLINE_SETTLEMENT_MODE || 'shadow',
  OFFLINE_MAX_WALLET_MINOR: parseInt(process.env.OFFLINE_MAX_WALLET_MINOR || '500000', 10),
  OFFLINE_MAX_TXN_MINOR: parseInt(process.env.OFFLINE_MAX_TXN_MINOR || '100000', 10),
  OFFLINE_TOKEN_EXPIRY_DAYS: parseInt(process.env.OFFLINE_TOKEN_EXPIRY_DAYS || '7', 10),
  OFFLINE_MAX_UNSYNCED_TXNS: parseInt(process.env.OFFLINE_MAX_UNSYNCED_TXNS || '20', 10),
  OFFLINE_REQUIRED_SYNC_HOURS: parseInt(process.env.OFFLINE_REQUIRED_SYNC_HOURS || '48', 10),

  SERVER_SIGNING_KEY_ID: process.env.SERVER_SIGNING_KEY_ID || 'server-key-dev',
  SERVER_SIGNING_PRIVATE_KEY_PATH: process.env.SERVER_SIGNING_PRIVATE_KEY_PATH || '',

  DEFAULT_WALLET_BALANCE_MINOR: parseInt(process.env.DEFAULT_WALLET_BALANCE_MINOR || '1000000', 10),
  DEFAULT_WALLET_CURRENCY: process.env.DEFAULT_WALLET_CURRENCY || 'LKR',
};

module.exports = config;
