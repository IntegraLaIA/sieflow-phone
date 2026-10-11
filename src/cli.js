#!/usr/bin/env node
// Small admin commands. Locally: node --env-file=.env src/cli.js <command>
// With Docker: docker compose run --rm sieflow-phone node src/cli.js <command>

import { createInterface } from 'node:readline/promises';
import { hashPassword } from './auth.js';
import { createGraph } from './graph.js';

const USAGE = `Usage: node src/cli.js <command>

Commands:
  hash-password [password]     Print a scrypt hash to use in USERS (reads stdin when no argument is given)
  calling-status               Show the calling settings of WA_PHONE_NUMBER_ID
  enable-calling [--no-icon]   Turn calling on (--no-icon hides the call button in the chat)
  disable-calling              Turn calling off`;

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Password (8 characters or more): ');
  rl.close();
  return answer;
}

function graphFromEnv() {
  const env = process.env;
  const missing = ['WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN'].filter((key) => !env[key]);
  if (missing.length) throw new Error(`Set ${missing.join(' and ')} first`);
  return createGraph({
    graphBaseUrl: (env.WA_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    graphVersion: env.WA_GRAPH_VERSION || 'v24.0',
    phoneNumberId: env.WA_PHONE_NUMBER_ID,
    accessToken: env.WA_ACCESS_TOKEN,
  });
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'hash-password': {
      const password = args[0] ?? (await readPassword());
      console.log(hashPassword(password));
      break;
    }
    case 'calling-status': {
      const settings = await graphFromEnv().getSettings();
      console.log(JSON.stringify(settings?.calling ?? settings, null, 2));
      break;
    }
    case 'enable-calling': {
      const icon = args.includes('--no-icon') ? 'DISABLE_ALL' : 'DEFAULT';
      await graphFromEnv().updateCallingSettings({ status: 'ENABLED', call_icon_visibility: icon });
      console.log(`Calling enabled (call button: ${icon === 'DEFAULT' ? 'visible' : 'hidden'})`);
      break;
    }
    case 'disable-calling': {
      await graphFromEnv().updateCallingSettings({ status: 'DISABLED' });
      console.log('Calling disabled');
      break;
    }
    default:
      console.log(USAGE);
      process.exit(command ? 64 : 0);
  }
} catch (error) {
  console.error(`SieFlow Phone: ${error.message}`);
  process.exit(1);
}
