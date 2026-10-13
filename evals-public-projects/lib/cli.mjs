/**
 * Small, strict command-line helpers shared by the suite's tools: flags
 * are declared, unknown flags are errors, and every tool prints JSON and
 * exits 0 (ok), 1 (checked and failed) or 2 (usage or internal error).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse `argv` against `{ valued: [...], repeated: [...], booleans: [...] }`.
 * Returns `{ positionals, flags }`; throws on anything undeclared.
 */
export function parseArgs(argv, { valued = [], repeated = [], booleans = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const name = a.slice(2);
    if (booleans.includes(name)) flags[name] = true;
    else if (valued.includes(name) || repeated.includes(name)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      if (repeated.includes(name)) (flags[name] ??= []).push(argv[++i]);
      else flags[name] = argv[++i];
    } else throw new Error(`unknown option ${a}`);
  }
  return { positionals, flags };
}

/** Run `main` when `importMetaUrl` is the entry point; print its JSON result and exit accordingly. */
export function runTool(importMetaUrl, main) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(importMetaUrl)) return;
  main(process.argv.slice(2)).then(
    (result) => {
      const text = JSON.stringify(result, null, 2);
      if (result?.out) writeFileSync(resolve(result.out), text + '\n');
      console.log(text);
      process.exitCode = result?.exit ?? (result?.ok ? 0 : 1);
    },
    (error) => {
      console.log(JSON.stringify({ ok: false, errors: [String(error?.stack ?? error)] }, null, 2));
      process.exitCode = 2;
    },
  );
}
