'use strict';

const router = require('express').Router();
const { getDb } = require('../db');

router.get('/', (req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'ok', serverTime: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable', serverTime: new Date().toISOString() });
  }
});

module.exports = router;
