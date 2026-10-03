#!/usr/bin/env node
// Mycelink launcher. Works from a plugin directory, an npm bin link or a hook
// command, on Windows, Linux and macOS, without a shell wrapper. It loads the
// prebuilt runtime bundle, so no npm install or TypeScript build is needed.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(join(here, '..', 'dist', 'mycelink.mjs'));

if (!existsSync(bundle)) {
  process.stderr.write(
    `Mycelink runtime bundle is missing (${bundle}).\n` +
      'Install from a release ZIP or the marketplace, or run "npm ci && npm run build" in a source checkout.\n',
  );
  process.exit(1);
}

await import(pathToFileURL(bundle).href);
