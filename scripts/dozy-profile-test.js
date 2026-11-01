#!/usr/bin/env node
const assert = require('assert/strict');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

function profile(endpoints, threshold = 1000, timeout = 2000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, 'dozy-profile.js')], {
      env: { ...process.env, ENDPOINTS: endpoints, THRESHOLD_MS: String(threshold), TIMEOUT_MS: String(timeout) },
      timeout: 8000,
      killSignal: 'SIGKILL'
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr }));
  });
}

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/fast') return res.end('asset');
    if (req.url === '/500') { res.writeHead(500); return res.end('error'); }
    if (req.url === '/302') { res.writeHead(302, { Location: '/fast' }); return res.end(); }
    if (req.url === '/204') { res.writeHead(204); return res.end(); }
    if (req.url === '/reset') return req.socket.destroy();
    if (req.url === '/no-headers') return;
    res.writeHead(200, { 'Content-Length': '100' });
    res.flushHeaders();
    if (req.url === '/stalled-body') return;
    if (req.url === '/trickle') {
      const timer = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    const timer = setTimeout(() => {
      if (req.url === '/aborted') res.destroy();
      else res.end('x'.repeat(100));
    }, req.url === '/aborted' ? 20 : 700);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failures = 0;
  const cases = [
    ['fast 200', '/fast', 1000, 2000, 0, /all endpoints within thresholds/],
    ['HTTP 500', '/500', 1000, 2000, 2, /FAIL:.*HTTP 500/],
    ['redirect rejected', '/302', 1000, 2000, 2, /FAIL:.*HTTP 302/],
    ['empty 204 rejected', '/204', 1000, 2000, 2, /FAIL:.*HTTP 204/],
    ['slow body', '/slow', 100, 2000, 2, /SLOW:/],
    ['completed body timing', '/slow', 2000, 3000, 0, /200 in (\d+)ms/],
    ['aborted body', '/aborted', 1000, 2000, 2, /FAIL:.*aborted/],
    ['request reset', '/reset', 1000, 2000, 2, /FAIL:.*socket hang up/],
    ['no headers timeout', '/no-headers', 1000, 150, 2, /FAIL:.*timeout/],
    ['stalled body timeout', '/stalled-body', 1000, 150, 2, /FAIL:.*timeout/],
    ['trickle deadline', '/trickle', 1000, 150, 2, /FAIL:.*timeout/],
    ['mixed endpoints', '/500,/fast', 1000, 2000, 2, /\/fast -> 200/],
    ['invalid threshold', '/fast', 'invalid', 2000, 2, /Invalid.*THRESHOLD_MS/],
    ['invalid timeout', '/fast', 1000, 0, 2, /Invalid.*TIMEOUT_MS/]
  ];
  try {
    for (const [name, endpoints, threshold, timeout, code, expected] of cases) {
      try {
        const result = await profile(endpoints.split(',').map(p => base + p).join(','), threshold, timeout);
        assert.equal(result.code, code, result.output);
        assert.match(result.output, expected);
        if (name === 'completed body timing') assert.ok(Number(result.output.match(expected)[1]) >= 650, result.output);
        if (code !== 0) assert.doesNotMatch(result.output, /all endpoints within thresholds/);
        console.log(`PASS: ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL: ${name}: ${error.message}`);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(failures, 0, `${failures}/${cases.length} Dozy regressions failed`);
  console.log(`Dozy regression suite passed: ${cases.length}/${cases.length}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
