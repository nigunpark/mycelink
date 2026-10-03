#!/usr/bin/env node
// Thin launcher so `mycelink` works from a plugin directory, an npm bin
// link, or a hook command, on native Windows without a shell wrapper.
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(join(here, '..', 'dist', 'index.js'));

if (!existsSync(dist)) {
  process.stderr.write(
    `mycelink is not built. Run "npm run build" in ${resolve(join(here, '..'))}.\n`,
  );
  process.exit(1);
}

await import(pathToFileURL(dist).href);
