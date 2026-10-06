/**
 * Hook enforcement and token safety.
 *
 * Every hook runs as a real child process reading stdin JSON, exactly as
 * Claude Code invokes it, so byte budgets and exit codes are measured, not
 * asserted in theory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import {
  FEATURE_ID,
  commitControl,
  createPortfolio,
  portfolioGraph,
  writePrd,
  type Portfolio,
} from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { mutateState } from '../../src/state/feature-state.js';
import { buildHookSettings } from '../../src/workspace/hook-settings.js';
import { readEvents } from '../../src/state/event-log.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { asController } from '../helpers/authority.js';
import { controllerArgv } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runHookProcess(
  p: Portfolio,
  event: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): HookResult {
  const proc = spawnSync(process.execPath, [LAUNCHER, 'hook', event, '--control-root', p.control], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MYCELINK_CONTROL_ROOT: p.control, ...env },
    windowsHide: true,
  });
  return { code: proc.status ?? -1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

async function cli(p: Portfolio, argv: string[]): Promise<number> {
  const io: CliIo = { out: () => {}, err: () => {} };
  return main([...asController(argv, p.control), '--control-root', p.control], io);
}

describe('hook registration', () => {
  it('registers every event the design requires, and they all exist in the CLI', () => {
    const settings = buildHookSettings('C:/plugin/bin/mycelink.mjs');
    expect(Object.keys(settings).sort()).toEqual(
      [
        'PostCompact',
        'PostToolUse',
        'PreCompact',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'TaskCompleted',
        'TaskCreated',
        'UserPromptSubmit',
      ].sort(),
    );
    // Tool-scoped hooks must be matched, not fired on every tool call.
    expect(settings['PreToolUse']?.[0]?.matcher).toContain('Edit');
    expect(settings['PreToolUse']?.[0]?.matcher).toContain('Bash');
    for (const matchers of Object.values(settings)) {
      for (const m of matchers) {
        for (const h of m.hooks) {
          expect(h.command).toContain('mycelink.mjs');
          expect(h.timeout).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('control-repo template', () => {
  it('the settings example matches what mycelink init actually generates', () => {
    const example = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'templates', 'control-repo', '.claude', 'settings.example.json'),
        'utf8',
      ),
    ) as { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]> };

    const real = buildHookSettings('<PLUGIN>/bin/mycelink.mjs');

    expect(Object.keys(example.hooks).sort()).toEqual(Object.keys(real).sort());
    for (const event of Object.keys(real)) {
      expect(`${event}:${example.hooks[event]?.[0]?.hooks[0]?.command}`).toBe(
        `${event}:${real[event]?.[0]?.hooks[0]?.command}`,
      );
      expect(`${event}:${example.hooks[event]?.[0]?.matcher}`).toBe(
        `${event}:${real[event]?.[0]?.matcher}`,
      );
    }
  });
});

describe('hook enforcement', () => {
  let p: Portfolio;
  const node = `${FEATURE_ID}.core.publish.impl`;

  beforeAll(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(
      join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'),
      YAML.stringify(portfolioGraph(), { lineWidth: 0 }),
      'utf8',
    );
    mkdirSync(join(p.featureDir, 'e2e'), { recursive: true });
    commitControl(p, 'scaffold');
    expect(await cli(p, ['feature', 'init', FEATURE_ID])).toBe(0);
  });

  // ---- context injection, with byte budgets ------------------------------

  it('SessionStart injects a bounded snapshot under 4 KiB', () => {
    const r = runHookProcess(p, 'session-start', { hook_event_name: 'SessionStart' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(FEATURE_ID);
    expect(r.stdout).toContain('ready:');
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(4096);
    // IDs, states and paths only: no file bodies, diffs or logs.
    expect(r.stdout).not.toContain('diff --git');
    expect(r.stdout).not.toContain('AssertionError');
  });

  it('UserPromptSubmit injects a delta under 2 KiB', () => {
    const r = runHookProcess(p, 'user-prompt-submit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'please continue',
    });
    expect(r.code).toBe(0);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(2048);
    // The prompt itself must never be echoed back into context.
    expect(r.stdout).not.toContain('please continue');
  });

  it('PreCompact and PostCompact succeed silently', () => {
    for (const event of ['pre-compact', 'post-compact']) {
      const r = runHookProcess(p, event, { hook_event_name: event });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
  });

  // ---- managed state -----------------------------------------------------

  it('blocks a direct edit of STATE.json', () => {
    const r = runHookProcess(p, 'pre-tool-use', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(p.featureDir, 'STATE.json') },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/controller-owned/i);
    expect(Buffer.byteLength(r.stderr, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it('blocks a direct edit of the graph, the event log and a candidate', () => {
    for (const target of [
      join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'),
      join(p.featureDir, 'events.jsonl'),
      join(p.featureDir, 'candidates', 'FEAT-901-C001.yaml'),
    ]) {
      const r = runHookProcess(p, 'pre-tool-use', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: target },
      });
      expect(`${target}:${r.code}`).toBe(`${target}:2`);
    }
  });

  it('allows an ordinary source edit when no node is active', () => {
    const r = runHookProcess(p, 'pre-tool-use', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(p.core, 'src', 'publish.js') },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  // ---- controller bypass -------------------------------------------------

  it('blocks raw git worktree, push and merge', () => {
    for (const command of [
      'git worktree add ../x feature/y',
      'git push origin main',
      'git merge feature/other',
    ]) {
      const r = runHookProcess(p, 'pre-tool-use', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      });
      expect(`${command}:${r.code}`).toBe(`${command}:2`);
      expect(r.stderr).toMatch(/mycelink/);
    }
  });

  it('blocks a raw E2E run that would bypass the runtime lease', () => {
    const r = runHookProcess(p, 'pre-tool-use', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npx playwright test tests/e2e' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/lease/i);
  });

  it('allows an ordinary shell command', () => {
    const r = runHookProcess(p, 'pre-tool-use', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(r.code).toBe(0);
  });

  it('blocks a worker session from spawning a subagent', () => {
    const r = runHookProcess(
      p,
      'pre-tool-use',
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'do more' } },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/subagent/i);
  });

  // ---- ownership fence and RED gate --------------------------------------

  it('blocks a production edit before a verified RED', async () => {
    expect(await cli(p, ['node', 'claim', FEATURE_ID, node])).toBe(0);
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    expect(existsSync(worktree)).toBe(true);

    const r = runHookProcess(
      p,
      'pre-tool-use',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(worktree, 'src', 'publish.js') },
        cwd: worktree,
      },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/RED/);
  });

  it('allows writing the failing test first', () => {
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    const r = runHookProcess(
      p,
      'pre-tool-use',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(worktree, 'tests', 'publish.test.js') },
        cwd: worktree,
      },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.code).toBe(0);
  });

  it('blocks an edit outside the ownership fence', () => {
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    const r = runHookProcess(
      p,
      'pre-tool-use',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(worktree, 'README.md') },
        cwd: worktree,
      },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ownership fence/i);
  });

  it('allows the worker to write its controller-assigned result file, even before RED', () => {
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    const r = runHookProcess(
      p,
      'pre-tool-use',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(worktree, '.mycelink-worker', 'result.json') },
        cwd: worktree,
      },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });

  it('allows only that one file in the result slot', () => {
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    for (const file of ['.gitignore', 'other.json']) {
      const r = runHookProcess(
        p,
        'pre-tool-use',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: join(worktree, '.mycelink-worker', file) },
          cwd: worktree,
        },
        { MYCELINK_NODE_ID: node },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/ownership fence/i);
    }
  });

  it('blocks an edit in another repository entirely', () => {
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    const r = runHookProcess(
      p,
      'pre-tool-use',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(p.api, 'src', 'consume.js') },
        cwd: worktree,
      },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/outside/i);
  });

  it('allows the production edit once a valid RED is on record', () => {
    mutateState(p.featureDir, (s) => {
      const runtime = s.nodes[node];
      if (runtime) {
        runtime.evidence.red = {
          kind: 'red',
          node_id: node,
          command: ['node', 'tests/run.mjs'],
          exit_code: 1,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          cwd: p.core,
          repository: 'core',
          commit_sha: null,
          output_path: join(p.featureDir, 'evidence', 'red.log'),
          output_sha256: 'a'.repeat(64),
          failure_fingerprint: 'fp',
          red_reason: 'behaviour-missing',
        };
      }
      return s;
    });
    const worktree = join(p.control, '.mycelink', 'worktrees', `core__${node.replace(/[^\w.-]/g, '_')}`);
    const r = runHookProcess(
      p,
      'pre-tool-use',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(worktree, 'src', 'publish.js') },
        cwd: worktree,
      },
      { MYCELINK_NODE_ID: node },
    );
    expect(r.code).toBe(0);
  });

  // ---- task guards -------------------------------------------------------

  it('blocks a task that names no graph node', () => {
    const r = runHookProcess(p, 'task-created', {
      hook_event_name: 'TaskCreated',
      task: { id: 't1', subject: 'Refactor everything', description: 'just do it' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/approved graph node id/i);
  });

  it('allows a task that names a claimed node', () => {
    const r = runHookProcess(p, 'task-created', {
      hook_event_name: 'TaskCreated',
      task: { id: 't2', subject: `work on ${node}`, description: '' },
    });
    expect(r.code).toBe(0);
  });

  it('blocks a task that names a node which is not schedulable', () => {
    const other = `${FEATURE_ID}.web.render.impl`;
    const r = runHookProcess(p, 'task-created', {
      hook_event_name: 'TaskCreated',
      task: { id: 't3', subject: `work on ${other}`, description: '' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/not READY or CLAIMED/i);
  });

  it('blocks completion without the required evidence', () => {
    const r = runHookProcess(p, 'task-completed', {
      hook_event_name: 'TaskCompleted',
      task: { id: 't2', subject: `finished ${node}`, description: '' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/evidence/i);
    expect(Buffer.byteLength(r.stderr, 'utf8')).toBeLessThanOrEqual(1024);
  });

  // ---- post tool use and stop -------------------------------------------

  it('PostToolUse records compact metadata and echoes nothing', () => {
    const before = readEvents(featurePaths(p.control, FEATURE_ID).events).length;
    const r = runHookProcess(p, 'post-tool-use', {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Edit',
      tool_input: { file_path: join(p.core, 'src', 'publish.js') },
      tool_response: { content: 'x'.repeat(50_000) },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');

    const events = readEvents(featurePaths(p.control, FEATURE_ID).events);
    expect(events.length).toBe(before + 1);
    const last = events[events.length - 1];
    expect(last?.type).toBe('tool.used');
    // The 50 KB payload must not be anywhere in the audit record.
    expect(JSON.stringify(last)).not.toContain('xxxxxxxxxx');
    expect(Buffer.byteLength(JSON.stringify(last), 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('Stop blocks while a claim and a lease are still held', async () => {
    const r = runHookProcess(p, 'stop', { hook_event_name: 'Stop' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/in-flight|leaked|live/i);

    // After releasing, stopping is allowed.
    expect(await cli(p, ['node', 'release', FEATURE_ID, node])).toBe(0);
    expect(await cli(p, ['node', 'block', FEATURE_ID, node, '--reason', 'operator stop'])).toBe(0);
    const after = runHookProcess(p, 'stop', { hook_event_name: 'Stop' });
    expect(after.code).toBe(0);
    expect(after.stdout).toBe('');
  });

  it('an explicit user stop is never blocked', () => {
    const r = runHookProcess(p, 'stop', { hook_event_name: 'Stop', stop_hook_active: true });
    expect(r.code).toBe(0);
  });

  it('a hook outside any control repository is a silent no-op', () => {
    const proc = spawnSync(
      process.execPath,
      [LAUNCHER, 'hook', 'session-start', '--control-root', join(p.root, 'nowhere')],
      { input: '{}', encoding: 'utf8', windowsHide: true },
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toBe('');
  });

  it('malformed stdin never breaks the session', () => {
    const proc = spawnSync(
      process.execPath,
      [LAUNCHER, 'hook', 'pre-tool-use', '--control-root', p.control],
      { input: 'not json at all', encoding: 'utf8', windowsHide: true },
    );
    expect(proc.status).toBe(0);
  });

  it('every hook stays well under a 10 s timeout budget', () => {
    const started = Date.now();
    runHookProcess(p, 'session-start', { hook_event_name: 'SessionStart' });
    runHookProcess(p, 'user-prompt-submit', { hook_event_name: 'UserPromptSubmit' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe('generated settings are valid JSON Claude Code can load', () => {
  it('mycelink init writes a .claude/settings.json with the hook block', async () => {
    const p = createPortfolio();
    const io: CliIo = { out: () => {}, err: () => {} };
    const target = join(p.root, 'fresh-control');
    expect(await main(controllerArgv(['init', target]), io)).toBe(0);

    const file = join(target, '.claude', 'settings.json');
    expect(existsSync(file)).toBe(true);
    const settings = JSON.parse(readFileSync(file, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(Object.keys(settings.hooks)).toContain('PreToolUse');
    expect(settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command).toContain('mycelink.mjs');
    expect(existsSync(join(target, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(target, 'mycelink.config.json'))).toBe(true);
  });

  it('re-running init does not duplicate the harness hook entries', async () => {
    const p = createPortfolio();
    const io: CliIo = { out: () => {}, err: () => {} };
    const target = join(p.root, 'twice-control');
    await main(controllerArgv(['init', target]), io);
    await main(controllerArgv(['init', target]), io);
    const settings = JSON.parse(
      readFileSync(join(target, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks['PreToolUse']).toHaveLength(1);
    expect(settings.hooks['SessionStart']).toHaveLength(1);
  });

  it('preserves hooks a user already configured', async () => {
    const p = createPortfolio();
    const io: CliIo = { out: () => {}, err: () => {} };
    const target = join(p.root, 'merge-control');
    mkdirSync(join(target, '.claude'), { recursive: true });
    writeFileSync(
      join(target, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
        permissions: { allow: ['Bash(npm test)'] },
      }),
      'utf8',
    );
    await main(controllerArgv(['init', target]), io);
    const settings = JSON.parse(
      readFileSync(join(target, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]>; permissions: unknown };
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    const commands = settings.hooks['PreToolUse']?.flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands).toContain('echo mine');
    expect(commands?.some((c) => c.includes('mycelink.mjs'))).toBe(true);
  });
});
