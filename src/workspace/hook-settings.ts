/**
 * Project hook registration for a control repository.
 *
 * The enforcement hooks are deliberately **project**-scoped, not plugin-
 * scoped: they must run in control repositories and worker worktrees and
 * nowhere else, so an unrelated project never pays for them.
 *
 * Every hook is a single short-lived Node process that reads stdin JSON and
 * writes nothing on success. None of them invoke a model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../util/paths.js';
import { writeTextAtomic } from '../state/atomic-json.js';

export interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export type HookSettings = Record<string, HookMatcher[]>;

/** Absolute path to this package's mycelink launcher. */
export function mycelinkCliPath(): string {
  return join(packageRoot(), 'bin', 'mycelink.mjs');
}

function cmd(event: string, launcher: string): string {
  return `node "${launcher.replace(/\\/g, '/')}" hook ${event}`;
}

/**
 * Hook registration, verified against Claude Code 2.1.274: every event name
 * below exists in the installed binary.
 */
export function buildHookSettings(launcher = mycelinkCliPath()): HookSettings {
  const simple = (event: string, timeout: number): HookMatcher[] => [
    { hooks: [{ type: 'command', command: cmd(event, launcher), timeout }] },
  ];

  return {
    // Inject the bounded canonical snapshot (<= 4 KiB).
    SessionStart: simple('session-start', 10),
    // Inject only the changed state delta (<= 2 KiB).
    UserPromptSubmit: simple('user-prompt-submit', 5),
    // Checkpoint before a compaction; the summary is never state.
    PreCompact: simple('pre-compact', 10),
    PostCompact: simple('post-compact', 10),
    // Authorise edits, guard the RED gate, block controller bypasses.
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Agent|Task',
        hooks: [{ type: 'command', command: cmd('pre-tool-use', launcher), timeout: 10 }],
      },
    ],
    // Compact event metadata only; never echoes the payload.
    PostToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: cmd('post-tool-use', launcher), timeout: 10 }],
      },
    ],
    // No task outside the graph; no completion without evidence.
    TaskCreated: simple('task-created', 10),
    TaskCompleted: simple('task-completed', 10),
    // Reclaim a dying worker's claim and leases.
    SubagentStop: simple('subagent-stop', 10),
    SessionEnd: simple('session-end', 10),
    // No false completion and no leaked lease.
    Stop: simple('stop', 15),
  };
}

export interface ClaudeSettings {
  hooks?: HookSettings;
  [key: string]: unknown;
}

/**
 * Write or update `.claude/settings.json`, preserving anything already there.
 * Only the harness's own hook entries are replaced.
 */
export function installHooks(controlRoot: string, launcher = mycelinkCliPath()): string {
  const file = join(controlRoot, '.claude', 'settings.json');
  const existing: ClaudeSettings = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as ClaudeSettings)
    : {};

  const ours = buildHookSettings(launcher);
  const merged: HookSettings = { ...(existing.hooks ?? {}) };

  for (const [event, matchers] of Object.entries(ours)) {
    const keep = (merged[event] ?? []).filter((m) => !m.hooks.some((h) => isOurHook(h.command)));
    merged[event] = [...keep, ...matchers];
  }

  writeTextAtomic(file, JSON.stringify({ ...existing, hooks: merged }, null, 2) + '\n');
  return file;
}

/** Only entries this package wrote; a user's own hooks are never touched. */
function isOurHook(command: string): boolean {
  return /mycelink\.mjs" hook [a-z-]+$/.test(command);
}

/**
 * Whether the control repository's Mycelink hooks point at a launcher that
 * exists. After a plugin update the installed copy may live elsewhere; the
 * fix is to re-run `mycelink init <control-repo>`, which rewrites only these
 * entries.
 */
export function hookHealth(controlRoot: string): { ok: boolean; detail: string } {
  const file = join(controlRoot, '.claude', 'settings.json');
  let settings: ClaudeSettings = {};
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ClaudeSettings) : {};
  } catch {
    return { ok: false, detail: `${file} is not valid JSON` };
  }
  const commands = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((m) => m.hooks.map((h) => h.command))
    .filter(isOurHook);
  if (commands.length === 0) {
    return { ok: false, detail: 'Mycelink hooks are not installed; run "mycelink init <control-repo>"' };
  }
  const launchers = new Set(commands.map((c) => /"([^"]+mycelink\.mjs)"/.exec(c)?.[1] ?? ''));
  const missing = [...launchers].filter((l) => l === '' || !existsSync(l));
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `hooks point at a missing launcher (${missing.join(', ')}); re-run "mycelink init <control-repo>" after updating the plugin`,
    };
  }
  return { ok: true, detail: [...launchers].join(', ') };
}
