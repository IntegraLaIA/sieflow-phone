#!/usr/bin/env node
import { createApp, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { log, setLogLevel } from './log.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`SieFlow Phone: ${error.message}`);
  process.exit(78);
}

setLogLevel(config.logLevel);
process.umask(0o077); // the database and its WAL files hold secrets
const app = await createApp(config);
const port = await app.listen();

log.info('SieFlow Phone is listening', { version: VERSION, port, demo: config.demo, database: app.db.file });
if (config.demo) {
  log.warn('DEMO MODE: the WhatsApp API is simulated. Do not expose this instance to the internet.');
  const login = config.demoLogin ? ` (user "${config.demoLogin.username}", password "${config.demoLogin.password}")` : '';
  console.log(`\n  Softphone:  http://localhost:${port}/${login}\n  Simulator:  http://localhost:${port}/simulator\n`);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    await app.close();
    process.exit(0);
  });
}
