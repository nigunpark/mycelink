/**
 * Controller authority for tests that drive the CLI as the controller.
 *
 * Opens a key per control repository the first time a controller-only
 * command needs one (before any claim exists, as the host does), and opens
 * a fresh one if a test rotated it. Commands outside the controller-only
 * table are passed through untouched, so worker-side calls never carry it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTROLLER_ONLY } from '../../src/cli/cli.js';
import { authorityFile, openControllerAuthority } from '../../src/engine/authority.js';
import { capabilityMatches } from '../../src/engine/capability.js';

const keys = new Map<string, string>();

function current(controlRoot: string, key: string): boolean {
  const file = authorityFile(controlRoot);
  if (!existsSync(file)) return false;
  try {
    return capabilityMatches(key, (JSON.parse(readFileSync(file, 'utf8')) as { sha256: string }).sha256);
  } catch {
    return false;
  }
}

/** The controller key for `controlRoot`, opening one if needed. */
export function controllerKey(controlRoot: string): string {
  const root = resolve(controlRoot);
  const known = keys.get(root);
  if (known !== undefined && current(root, known)) return known;
  const opened = openControllerAuthority(root).authority;
  keys.set(root, opened);
  return opened;
}

export function isControllerOnly(argv: readonly string[]): boolean {
  const group = argv[0];
  if (group === undefined) return false;
  const only = CONTROLLER_ONLY[group];
  return only === '*' || (only !== undefined && only.has(argv[1] ?? ''));
}

/**
 * `argv` with `--authority` added when it is a controller-only command on an
 * initialised control repository and none was given.
 */
export function asController(argv: string[], controlRoot: string): string[] {
  if (!isControllerOnly(argv) || argv.includes('--authority')) return argv;
  if (argv[0] === 'init' && !existsSync(resolve(argv[1] ?? '.', 'mycelink.config.json'))) return argv;
  const root = argv[0] === 'init' ? resolve(argv[1] as string) : controlRoot;
  const dd = argv.indexOf('--');
  const extra = ['--authority', controllerKey(root)];
  return dd === -1 ? [...argv, ...extra] : [...argv.slice(0, dd), ...extra, ...argv.slice(dd)];
}


/** `asController` for an argv that names its own `--control-root` (or an `init` target). */
export function controllerArgv(argv: string[]): string[] {
  const i = argv.indexOf('--control-root');
  const root = i !== -1 ? (argv[i + 1] as string) : argv[0] === 'init' ? (argv[1] as string) : process.cwd();
  if (!existsSync(resolve(root, 'mycelink.config.json'))) return argv;
  return asController(argv, root);
}
