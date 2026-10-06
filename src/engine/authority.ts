/**
 * Controller authority.
 *
 * Every controller-only command needs `--authority <key>`, a random 256-bit
 * key minted by `mycelink controller open` and printed once to whoever
 * opened it. Only its SHA-256 is stored, under the control repository's
 * scratch area. Not presenting a worker capability is not authority: a
 * host-dispatched worker shares the host's OS user and shell, so it can
 * always omit its own token.
 *
 * The key never enters a ticket, worker prompt, context pack, worktree or
 * environment. The first key of a control repository is minted before any
 * work can be dispatched (dispatch itself needs it), so before any worker
 * exists. After that a new key is minted only by presenting the current one
 * (rotation, and only while no claim is live) or by an operator taking over
 * from an interactive terminal (`--takeover`), which a Bash tool call does
 * not have. "No claim is live" alone is not enough: a worker holds its own
 * claim capability and can end its own claim (settle it, or fail a gate
 * into BLOCKED) while it keeps running.
 *
 * Within one OS user this is the strongest protocol a host can mediate, not
 * an OS boundary: a hostile process running as the same user can read the
 * host's transcript or process list, or rewrite the stored hash.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedArgs } from '../cli/args.js';
import { capabilityMatches, newCapability, presentedCapability, RoleDeniedError } from './capability.js';
import { controlPaths } from '../workspace/paths.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { withLock } from '../state/process-lock.js';

export const AUTHORITY_FLAG = 'authority';
const AUTHORITY_FORMAT = /^[0-9a-f]{64}$/;

export type AuthorityCode =
  | 'CONTROLLER_AUTHORITY_REQUIRED'
  | 'CONTROLLER_AUTHORITY_INVALID'
  | 'CONTROLLER_AUTHORITY_EXISTS'
  | 'CONTROLLER_BUSY';

export class AuthorityError extends Error {
  readonly code: AuthorityCode;
  constructor(code: AuthorityCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AuthorityError';
    this.code = code;
  }
}

interface AuthorityRecord {
  schema: 'mycelink-controller-authority/1';
  sha256: string;
  opened_at: string;
  takeover: boolean;
}

export function authorityFile(controlRoot: string): string {
  return join(controlPaths(controlRoot).workDir, 'controller-authority.json');
}

function readRecord(controlRoot: string): AuthorityRecord | null {
  const file = authorityFile(controlRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AuthorityRecord>;
    if (parsed.schema !== 'mycelink-controller-authority/1' || typeof parsed.sha256 !== 'string' || !AUTHORITY_FORMAT.test(parsed.sha256)) {
      return null;
    }
    return parsed as AuthorityRecord;
  } catch {
    return null;
  }
}

/** Every `<feature>:<node>` holding a claim, across the control repository. */
export function liveClaims(controlRoot: string): string[] {
  const dir = controlPaths(controlRoot).featuresDir;
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const feature of readdirSync(dir).sort()) {
    const file = join(dir, feature, 'STATE.json');
    if (!existsSync(file)) continue;
    let nodes: Record<string, { claim?: unknown }> = {};
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { data?: { nodes?: typeof nodes }; nodes?: typeof nodes };
      nodes = doc.data?.nodes ?? doc.nodes ?? {};
    } catch {
      // An unreadable state cannot prove that no worker is running.
      out.push(`${feature}:(unreadable STATE.json)`);
      continue;
    }
    for (const [id, rt] of Object.entries(nodes)) if (rt?.claim) out.push(`${feature}:${id}`);
  }
  return out;
}

export interface OpenedAuthority {
  authority: string;
  opened_at: string;
  takeover: boolean;
}

/**
 * Mint and store a new controller key, revoking the previous one.
 *
 * The first key needs nothing (no work can have been dispatched without
 * one). Any later key needs the current one (`current`) and no live claim,
 * or an operator taking over from an interactive terminal.
 */
export function openControllerAuthority(
  controlRoot: string,
  options: { takeover?: boolean; interactive?: boolean; current?: string } = {},
): OpenedAuthority {
  const paths = controlPaths(controlRoot);
  if (!existsSync(paths.config)) {
    throw new Error(`NOT_A_CONTROL_REPOSITORY: ${controlRoot} has no mycelink.config.json; run mycelink init first.`);
  }
  const takeover = options.takeover === true;
  if (takeover && options.interactive !== true) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      '--takeover needs an interactive terminal (a TTY on stdin and stdout); run it yourself, not through an agent tool.',
    );
  }
  return withLock(
    join(paths.workDir, 'controller-authority.lock'),
    () => {
      if (!takeover && existsSync(authorityFile(controlRoot))) {
        const record = readRecord(controlRoot);
        if (options.current === undefined || options.current === '') {
          throw new AuthorityError(
            'CONTROLLER_AUTHORITY_EXISTS',
            'a controller key is already open for this control repository. Use it, or rotate it with controller open --authority <current key>. If it is lost, the operator runs mycelink controller open --takeover in an interactive terminal.',
          );
        }
        if (record === null || !capabilityMatches(options.current, record.sha256)) {
          throw new AuthorityError('CONTROLLER_AUTHORITY_INVALID', 'the key presented to rotate is not the current controller key.');
        }
      }
      const live = liveClaims(controlRoot);
      if (live.length > 0 && !takeover) {
        throw new AuthorityError(
          'CONTROLLER_BUSY',
          `claims are live (${live.slice(0, 5).join(', ')}${live.length > 5 ? ', ...' : ''}); controller authority cannot be minted while a worker may be running. Use the key you opened earlier, or, as the operator in an interactive terminal, mycelink controller open --takeover.`,
        );
      }
      const key = newCapability();
      const record: AuthorityRecord = {
        schema: 'mycelink-controller-authority/1',
        sha256: key.sha256,
        opened_at: new Date().toISOString(),
        takeover,
      };
      writeTextAtomic(authorityFile(controlRoot), JSON.stringify(record, null, 2) + '\n');
      return { authority: key.raw, opened_at: record.opened_at, takeover };
    },
    { timeoutMs: 5_000, pollMs: 50, purpose: 'controller authority' },
  );
}

/**
 * Require positive controller authority for `operation`.
 *
 * A presented worker capability (flag or environment) is refused first, so
 * authority never launders a worker's token.
 */
export function assertControllerAuthority(args: ParsedArgs, controlRoot: string, operation: string): void {
  const flag = args.flags['capability'];
  if ((typeof flag === 'string' && flag !== '') || flag === true || presentedCapability(args) !== undefined) {
    throw new RoleDeniedError(operation);
  }
  const presented = args.flags[AUTHORITY_FLAG];
  if (typeof presented !== 'string' || presented === '') {
    throw new AuthorityError(
      'CONTROLLER_AUTHORITY_REQUIRED',
      `"${operation}" is a controller operation; pass --authority <key> from mycelink controller open. Workers never hold it.`,
    );
  }
  const record = readRecord(controlRoot);
  if (record === null) {
    throw new AuthorityError('CONTROLLER_AUTHORITY_REQUIRED', `no controller authority is open for ${controlRoot}; run mycelink controller open.`);
  }
  if (!capabilityMatches(presented, record.sha256)) {
    throw new AuthorityError(
      'CONTROLLER_AUTHORITY_INVALID',
      `the authority presented for "${operation}" is not the current controller key (wrong, forged or rotated).`,
    );
  }
}

