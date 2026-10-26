'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { ServiceClient } = require('../src/service-client');
const { Store } = require('../src/store');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test('stopped proxy keeps one local store across status polls instead of reopening the database', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-client-'));
  const port = await freePort();
  const client = await new ServiceClient(directory, path.join(__dirname, '..'), port).init();
  t.after(async () => { client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const original = Store.prototype.init;
  let reads = 0;
  Store.prototype.init = function init() { reads++; return original.call(this); };
  t.after(() => { Store.prototype.init = original; });
  const first = await client.state({ range: 'today' });
  const second = await client.state({ range: 'today' });
  assert.equal(first.service.running, false);
  assert.equal(second.service.running, false);
  assert.equal(reads, 1);
});

test('running proxy state is fetched over the authenticated admin endpoint', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-client-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const client = await new ServiceClient(directory, path.join(__dirname, '..'), await freePort()).init();
  let sawToken = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/_meter/health')) {
      const body = JSON.stringify({ product: 'deepseek-token-meter', fingerprint: client.fingerprint, port: client.port });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body); return;
    }
    sawToken = req.headers['x-meter-token'] === client.token;
    assert.match(req.url, /^\/_meter\/state\?range=today&model=deepseek-chat$/);
    const body = JSON.stringify({ totals: { total: 1 }, config: { prices: [] }, service: { running: true }, warnings: [] });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise(resolve => server.listen(client.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const state = await client.state({ range: 'today', model: 'deepseek-chat', from: '' });
  assert.equal(state.service.running, true);
  assert.equal(sawToken, true);
});

test('health rejects a different program already listening on the configured port', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-client-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const client = await new ServiceClient(directory, path.join(__dirname, '..'), await freePort()).init();
  const server = http.createServer((_req, res) => { const body = '{"product":"other"}'; res.writeHead(200, { 'content-length': body.length }).end(body); });
  await new Promise(resolve => server.listen(client.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(client.health(), /已被其他程序占用/);
});
