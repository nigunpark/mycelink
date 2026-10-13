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
 *
 * A key records the session that opened it: the Claude Code process named
 * by CLAUDE_PID, believed only when it is an ancestor of the call, with its
 * start (util/process-identity.ts). When that session dies (a crash, an
 * interrupted `claude -p`), its key dies with it, and so does every
 * subagent it ran: host-dispatched workers run inside the host process. A
 * fresh session of the host then recovers authority without anyone at a
 * terminal: `controller open --recover` mints a new key, revoking the old
 * one, only when the recorded holder is provably gone, the caller runs in a
 * verifiable session of its own, and no adapter worker session or settle is
 * still alive. A subagent of a live host finds its own host recorded as the
 * holder, alive, and is refused; a key opened outside a verifiable session
 * (no holder) is recovered only by the operator's `--takeover`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedArgs } from '../cli/args.js';
import { capabilityMatches, newCapability, presentedCapability, RoleDeniedError } from './capability.js';
import { controlPaths } from '../workspace/paths.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { isPidAlive, withLock } from '../state/process-lock.js';
import { isProcessAlive, processStartedAt, type ProcessIdentity } from '../util/process-identity.js';
import { settlerAlive, type SettlerMarker } from './settler.js';
import { liveSessions } from '../sessions/registry.js';

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
  /** The session that opened the key; null when it could not be verified (records before holders: absent). */
  holder?: ProcessIdentity | null;
  /** Minted by `--recover` after its previous holder ended. */
  recovered?: boolean;
  /** When the key this one replaced was opened. */
  previous_opened_at?: string;
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
  recovered: boolean;
  /** The session the key is bound to, or null when none could be verified. */
  holder: ProcessIdentity | null;
}

/**
 * Work of a previous session that may still be running and could act on
 * recovered authority: an adapter worker session whose process is alive,
 * or a settle whose settler is alive. Host-dispatched workers are not
 * listed: they run inside their host's process.
 */
export function liveWork(controlRoot: string): string[] {
  const dir = controlPaths(controlRoot).featuresDir;
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const feature of readdirSync(dir).sort()) {
    const featureDir = join(dir, feature);
    try {
      const registry = join(featureDir, 'sessions', 'registry.json');
      if (existsSync(registry)) {
        for (const s of liveSessions(registry)) {
          if (typeof s.pid !== 'number' || !isPidAlive(s.pid)) continue;
          const started = processStartedAt(s.pid);
          const since = Date.parse(s.started_at);
          // A pid whose current process started after the session did is a reused pid.
          if (started !== null && !Number.isNaN(since) && started > since + 5_000) continue;
          out.push(`${feature}:session ${s.session_id}`);
        }
      }
      const stateFile = join(featureDir, 'STATE.json');
      if (existsSync(stateFile)) {
        const doc = JSON.parse(readFileSync(stateFile, 'utf8')) as { data?: { nodes?: Record<string, { claim?: { settling?: SettlerMarker | null } | null }> } };
        for (const [id, rt] of Object.entries(doc.data?.nodes ?? {})) {
          const settling = rt.claim?.settling;
          if (settling && settlerAlive(settling)) out.push(`${feature}:settle of ${id}`);
        }
      }
    } catch {
      // An unreadable registry or state cannot prove that nothing is running.
      out.push(`${feature}:(unreadable state)`);
    }
  }
  return out;
}

/**
 * Mint and store a new controller key, revoking the previous one.
 *
 * The first key needs nothing (no work can have been dispatched without
 * one). Any later key needs the current one (`current`) and no live claim,
 * an operator taking over from an interactive terminal, or (`recover`) a
 * fresh session of the host after the session that held the key ended.
 * `holder` is the verified session of the caller (util/process-identity.ts
 * `sessionHolder`); it is recorded with the key.
 */
export function openControllerAuthority(
  controlRoot: string,
  options: { takeover?: boolean; interactive?: boolean; current?: string; recover?: boolean; holder?: ProcessIdentity | null } = {},
): OpenedAuthority {
  const paths = controlPaths(controlRoot);
  if (!existsSync(paths.config)) {
    throw new Error(`NOT_A_CONTROL_REPOSITORY: ${controlRoot} has no mycelink.config.json; run mycelink init first.`);
  }
  const takeover = options.takeover === true;
  const recover = options.recover === true && !takeover;
  const holder = options.holder ?? null;
  if (takeover && options.interactive !== true) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      '--takeover needs an interactive terminal (a TTY on stdin and stdout); run it yourself, not through an agent tool.',
    );
  }
  return withLock(
    join(paths.workDir, 'controller-authority.lock'),
    () => {
      const previous = existsSync(authorityFile(controlRoot)) ? readRecord(controlRoot) : null;
      if (recover) {
        if (previous === null) {
          throw new AuthorityError('CONTROLLER_AUTHORITY_REQUIRED', 'no controller key was ever opened for this control repository; run controller open.');
        }
        assertRecoverable(controlRoot, previous, holder);
      } else if (!takeover && existsSync(authorityFile(controlRoot))) {
        if (options.current === undefined || options.current === '') {
          throw new AuthorityError(
            'CONTROLLER_AUTHORITY_EXISTS',
            'a controller key is already open for this control repository. Use it, or rotate it with controller open --authority <current key>. A fresh session of the host, after the session that held the key ended, runs controller open --recover; otherwise the operator runs mycelink controller open --takeover in an interactive terminal. Never search for the key.',
          );
        }
        if (previous === null || !capabilityMatches(options.current, previous.sha256)) {
          throw new AuthorityError('CONTROLLER_AUTHORITY_INVALID', 'the key presented to rotate is not the current controller key.');
        }
      }
      const live = liveClaims(controlRoot);
      if (live.length > 0 && !takeover && !recover) {
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
        holder,
        ...(recover ? { recovered: true } : {}),
        ...(previous !== null ? { previous_opened_at: previous.opened_at } : {}),
      };
      writeTextAtomic(authorityFile(controlRoot), JSON.stringify(record, null, 2) + '\n');
      return { authority: key.raw, opened_at: record.opened_at, takeover, recovered: recover, holder };
    },
    { timeoutMs: 5_000, pollMs: 50, purpose: 'controller authority' },
  );
}

/** Refuse `--recover` unless the key's session is provably gone and nothing of it still runs. */
function assertRecoverable(controlRoot: string, previous: AuthorityRecord, caller: ProcessIdentity | null): void {
  if (caller === null) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      'recovery needs a verifiable host session: run it from the Claude Code session that will hold the key (its CLAUDE_PID must be an ancestor of the call). A worker never recovers authority.',
    );
  }
  const holder = previous.holder ?? null;
  if (holder === null) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      'the current key was opened outside a verifiable session, so nothing can prove its holder is gone; the operator runs mycelink controller open --takeover in an interactive terminal.',
    );
  }
  const alive = isProcessAlive(holder);
  if (alive === true) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      `the session that holds the current key (pid ${holder.pid}) is still running; use the key it holds. A worker of that session never recovers authority.`,
    );
  }
  if (alive === null) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      `the session that holds the current key ran on ${holder.host}; its end cannot be proved here. The operator runs mycelink controller open --takeover in an interactive terminal.`,
    );
  }
  const busy = liveWork(controlRoot);
  if (busy.length > 0) {
    throw new AuthorityError(
      'CONTROLLER_BUSY',
      `work of the previous session may still be running (${busy.slice(0, 5).join(', ')}${busy.length > 5 ? ', ...' : ''}); recover once it has ended, or stop it first.`,
    );
  }
}

/**
 * Whether `text` contains the current controller key anywhere, including
 * inside a longer run of hex digits. Text handed to a worker is checked with
 * this, so controller authority is never relayed to one.
 */
export function holdsControllerKey(controlRoot: string, text: string): boolean {
  const record = readRecord(controlRoot);
  if (record === null) return false;
  for (const run of text.toLowerCase().match(/[0-9a-f]{64,}/g) ?? []) {
    for (let i = 0; i + 64 <= run.length; i++) {
      if (capabilityMatches(run.slice(i, i + 64), record.sha256)) return true;
    }
  }
  return false;
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

