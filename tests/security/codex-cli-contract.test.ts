import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { planCommand } from '../../src/security/exec.js';

const live = process.env.MYCELINK_LIVE_CODEX === '1';
afterAll(() => cleanupTmpRoots());

describe('installed Codex CLI contract (live opt-in)', () => {
  it.skipIf(!live)('accepts a stdin prompt, JSONL, safe sandbox, explicit approval config and final-output file', () => {
    const dir = makeTmpDir('codex-spike-');
    const output = join(dir, 'last.txt');
    const schema = join(dir, 'schema.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }));
    const plan = planCommand(['codex', 'exec', '--json', '--ignore-user-config', '-c', 'approval_policy=never', '--sandbox', 'read-only', '--cd', process.cwd(), '--output-schema', schema, '--output-last-message', output, '-']);
    const result = spawnSync(plan.file, plan.args, {
      input: 'Return {"ok":true} only. Do not use tools.\n', encoding: 'utf8',
      cwd: process.cwd(), timeout: 90_000, windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    const events = (result.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    // Never print stdout/stderr: they can contain prompt content or provider IDs.
    expect({ exit: result.status, types: events.map((e) => e['type']) }).toMatchObject({
      exit: 0, types: ['thread.started', 'turn.started', 'item.completed', 'turn.completed'],
    });
    expect(events.at(-1)?.['usage']).toMatchObject({ input_tokens: expect.any(Number), output_tokens: expect.any(Number) });
    expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ ok: true });
  }, 100_000);

  it('records only sanitized fixture shapes and the precise CLI compatibility decision', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/codex-cli/success.json', 'utf8')) as { events: { type: string }[] };
    expect(fixture.events.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(readFileSync('docs/CODEX_COMPATIBILITY.md', 'utf8')).toContain('0.163.0');
    expect(readFileSync('docs/CODEX_COMPATIBILITY.md', 'utf8')).toContain('`-c approval_policy=never`');
    expect(readFileSync('docs/CODEX_COMPATIBILITY.md', 'utf8')).toContain('`-a`');
  });
});
