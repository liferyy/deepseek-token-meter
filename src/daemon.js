'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Store } = require('./store');
const { createMeterServer } = require('./proxy');

async function main() {
  const directory = process.argv[2];
  const port = Number(process.argv[3]);
  if (!directory || !path.isAbsolute(directory) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_arguments');
  const token = (await fs.readFile(path.join(directory, 'admin-token'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid_admin_token');
  const store = await new Store(directory, port).init();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await meter.close();
    store.close();
    process.exit(0);
  };
  const fingerprint = createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 20);
  const meter = createMeterServer({ store, token, port, fingerprint, onShutdown: shutdown,
    onError: message => { if (!store.warnings.includes(message)) store.warnings.push(message); } });
  await new Promise((resolve, reject) => { meter.server.once('error', reject); meter.server.listen(port, '127.0.0.1', resolve); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  const maintenance = setTimeout(() => {
    store.maintenance().catch(() => {
      const warning = '本地数据库维护失败，后续启动时将重试';
      if (!store.warnings.includes(warning)) store.warnings.push(warning);
    });
  }, 1000);
  maintenance.unref();
  // The editor keeps the daemon alive with a cheap health heartbeat while it is running; without
  // one (window closed, extension disabled, host crashed) the service exits after ten idle minutes.
  setInterval(() => { if (!meter.active && Date.now() - meter.lastActivity > 600000) shutdown(); }, 30000).unref();
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main };
