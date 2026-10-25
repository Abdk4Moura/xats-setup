#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainPeer } from './lib/peer-cli.mjs';

const stateDir = path.dirname(fileURLToPath(import.meta.url));
mainPeer(process.argv.slice(2), { stateDir }).catch((error) => {
  console.error(`xats peer: ${error.message || String(error)}`);
  process.exitCode = 1;
});
