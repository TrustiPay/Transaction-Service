'use strict';

require('dotenv').config();

const { initDb } = require('./src/db');
const { initSigner } = require('./src/crypto/tokenSigner');
const { startJobs } = require('./src/services/jobs');
const config = require('./src/config');
const app = require('./src/app');

async function main() {
  initDb();
  await initSigner();
  startJobs();

  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[server] TrustiPay transaction service running on port ${config.PORT} (${config.NODE_ENV})`);
    console.log(`[server] Offline payments: ${config.OFFLINE_PAYMENTS_ENABLED ? 'ENABLED' : 'DISABLED'}, mode: ${config.OFFLINE_SETTLEMENT_MODE}`);
  });
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
