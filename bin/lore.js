#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`lore: ${err?.stack || err}`);
  process.exit(1);
});
