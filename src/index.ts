#!/usr/bin/env node
/** `mycelink` entrypoint. */
import { main } from './cli/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
