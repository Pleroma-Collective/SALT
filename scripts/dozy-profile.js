#!/usr/bin/env node
// Dozy — Lightweight HTTP response time profiler for key endpoints

const http = require('http');
const https = require('https');

const ENDPOINTS = (process.env.ENDPOINTS || 'http://127.0.0.1:3000/').split(',').map(s=>s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || '5000');
const THRESHOLD_MS = Number(process.env.THRESHOLD_MS || '500');

if (!ENDPOINTS.length || !Number.isInteger(TIMEOUT_MS) || TIMEOUT_MS <= 0 || TIMEOUT_MS > 2147483647 ||
    !Number.isFinite(THRESHOLD_MS) || THRESHOLD_MS < 0) {
  console.error('Invalid ENDPOINTS, TIMEOUT_MS (positive timer integer), or THRESHOLD_MS (non-negative number)');
  process.exit(2);
}

async function check(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, ...result });
    };
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      res.on('error', err => finish({ error: err.message }));
      res.on('aborted', () => finish({ error: 'response aborted' }));
      if (res.statusCode !== 200) {
        finish({ error: `HTTP ${res.statusCode} (expected 200)` });
        res.destroy();
        return;
      }
      res.on('end', () => finish({ status: res.statusCode, time: Date.now() - start }));
      res.resume(); // Drain the complete asset without retaining its body.
    });
    req.on('error', err => finish({ error: err.message }));
    // A total deadline also bounds DNS/connect and continuously trickling bodies.
    const timer = setTimeout(() => {
      finish({ error: 'timeout' });
      req.destroy();
    }, TIMEOUT_MS);
  });
}

(async () => {
  console.log(`Dozy: profiling ${ENDPOINTS.length} endpoint(s)`);
  let failures = 0;
  for (const e of ENDPOINTS) {
    const r = await check(e).catch(err => ({ error: err.message }));
    if (r.error) {
      console.error(`FAIL: ${e} - ${r.error}`);
      failures++;
      continue;
    }
    console.log(`${e} -> ${r.status} in ${r.time}ms`);
    if (r.time > THRESHOLD_MS) {
      console.error(`SLOW: ${e} response ${r.time}ms > ${THRESHOLD_MS}ms`);
      failures++;
    }
  }
  if (failures > 0) process.exit(2);
  console.log('Dozy: all endpoints within thresholds');
  process.exit(0);
})();
