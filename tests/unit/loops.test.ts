import { describe, expect, it } from 'vitest';
import { afterAll } from 'vitest';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import {
  defaultLoops,
  loadLoops,
  validateLoops,
  writeLoops,
  type LoopContract,
} from '../../src/loops/contracts.js';
import { appendRun, runSummary, type RunRecord } from '../../src/loops/runs.js';
import { readEvents } from '../../src/state/event-log.js';

afterAll(() => cleanupTmpRoots());

const REQUIRED_FIELDS = [
  'trigger',
  'success_condition',
  'stop_conditions',
  'deterministic_verifier',
  'max_attempts',
  'max_same_failure',
  'max_model_turns',
  'max_wall_clock_ms',
  'max_usage_budget',
] as const;

describe('loop contracts', () => {
  it('the default set is valid and covers every required loop layer', () => {
    const loops = defaultLoops('FEAT-1', 'mycelink');
    const result = validateLoops(loops);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);

    const types = loops.loops.map((l) => l.loop_type).sort();
    expect(types).toEqual(
      ['feature-orchestration', 'node-agent', 'review', 'runtime-e2e', 'verification'].sort(),
    );
  });

  it.each(REQUIRED_FIELDS)('refuses a loop missing %s', (field) => {
    const loops = defaultLoops('FEAT-1', 'mycelink');
    const broken = structuredClone(loops) as { loops: Record<string, unknown>[] };
    delete broken.loops[0]?.[field];
    const result = validateLoops(broken);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('SCHEMA');
  });

  it('refuses a non-positive budget', () => {
    const loops = structuredClone(defaultLoops('FEAT-1', 'mycelink'));
    (loops.loops[0] as LoopContract).max_attempts = 0;
    expect(validateLoops(loops).ok).toBe(false);
  });

  it('refuses an empty stop-condition list: every loop must be able to end', () => {
    const loops = structuredClone(defaultLoops('FEAT-1', 'mycelink'));
    (loops.loops[0] as LoopContract).stop_conditions = [];
    expect(validateLoops(loops).ok).toBe(false);
  });

  it('refuses a duplicate loop id', () => {
    const loops = structuredClone(defaultLoops('FEAT-1', 'mycelink'));
    loops.loops.push(structuredClone(loops.loops[0] as LoopContract));
    expect(validateLoops(loops).problems.map((p) => p.code)).toContain('DUPLICATE_LOOP_ID');
  });

  it('refuses a child loop whose parent does not exist, so usage cannot escape the budget', () => {
    const loops = structuredClone(defaultLoops('FEAT-1', 'mycelink'));
    (loops.loops[1] as LoopContract).parent_loop_id = 'ghost-parent';
    expect(validateLoops(loops).problems.map((p) => p.code)).toContain('UNKNOWN_PARENT_LOOP');
  });

  it('every child loop names a real parent, so child usage rolls up', () => {
    const loops = defaultLoops('FEAT-1', 'mycelink');
    const ids = new Set(loops.loops.map((l) => l.loop_id));
    const children = loops.loops.filter((l) => l.parent_loop_id !== null);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(ids.has(child.parent_loop_id as string)).toBe(true);
    }
  });

  it('the runtime loop requires the capacity-1 resources and never blind-retries', () => {
    const loops = defaultLoops('FEAT-1', 'mycelink');
    const runtime = loops.loops.find((l) => l.loop_type === 'runtime-e2e') as LoopContract;
    expect(runtime.required_resource).toContain('full-runtime');
    expect(runtime.required_resource).toContain('deploy-slot');
    expect(runtime.max_attempts).toBe(1);
    expect(runtime.on_failure).toMatch(/attribute/i);
  });

  it('round-trips through YAML on disk', () => {
    const dir = makeTmpDir('loops-');
    const file = join(dir, 'LOOPS.yaml');
    writeLoops(file, defaultLoops('FEAT-1', 'mycelink'));
    const loaded = loadLoops(file);
    expect(loaded.ok).toBe(true);
    expect(loaded.loops).toHaveLength(5);
  });

  it('reports a missing LOOPS.yaml rather than silently allowing the run', () => {
    const dir = makeTmpDir('loops-');
    const result = loadLoops(join(dir, 'nope.yaml'));
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.code).toBe('MISSING_LOOPS');
  });
});

describe('run ledger', () => {
  function record(patch: Partial<RunRecord> = {}): RunRecord {
    return {
      attempt_id: 'N1#1',
      idempotency_key: 'N1#1#sess',
      loop_id: 'node-agent:FEAT-1',
      parent_loop_id: 'feature-orchestration:FEAT-1',
      node_id: 'FEAT-1.a.b.impl',
      candidate_sha: null,
      input_hash: 'abc123',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      model_turns: 5,
      usage: { input_tokens: 100, output_tokens: 50 },
      wall_clock_ms: 60_000,
      commands: ['npm test'],
      exit_codes: [1],
      failure_fingerprint: 'fp-1',
      evidence_paths: ['evidence/red.log'],
      transition: 'failed',
      ...patch,
    };
  }

  it('appends an attempt and summarises it', () => {
    const dir = makeTmpDir('runs-');
    const file = join(dir, 'RUNS.jsonl');
    expect(appendRun(file, record())).toBe(true);

    const summary = runSummary(file);
    expect(summary.attempts).toBe(1);
    expect(summary.total_model_turns).toBe(5);
    expect(summary.last_failure_fingerprint).toBe('fp-1');
  });

  it('is idempotent: a duplicated delivery is recorded once', () => {
    const dir = makeTmpDir('runs-');
    const file = join(dir, 'RUNS.jsonl');
    expect(appendRun(file, record())).toBe(true);
    expect(appendRun(file, record())).toBe(false);
    expect(runSummary(file).attempts).toBe(1);
  });

  it('counts repeated fingerprints so a loop cannot hide a repeat', () => {
    const dir = makeTmpDir('runs-');
    const file = join(dir, 'RUNS.jsonl');
    appendRun(file, record({ idempotency_key: 'a', attempt_id: 'N1#1' }));
    appendRun(file, record({ idempotency_key: 'b', attempt_id: 'N1#2' }));
    const summary = runSummary(file);
    expect(summary.repeated_failures['fp-1']).toBe(2);
  });

  it('filters the summary to one node', () => {
    const dir = makeTmpDir('runs-');
    const file = join(dir, 'RUNS.jsonl');
    appendRun(file, record({ idempotency_key: 'a', node_id: 'N-A' }));
    appendRun(file, record({ idempotency_key: 'b', node_id: 'N-B' }));
    expect(runSummary(file, 'N-A').attempts).toBe(1);
    expect(runSummary(file).attempts).toBe(2);
  });

  it('caps what a single attempt can put in the ledger', () => {
    const dir = makeTmpDir('runs-');
    const file = join(dir, 'RUNS.jsonl');
    appendRun(
      file,
      record({
        commands: Array.from({ length: 50 }, (_, i) => `cmd-${i} ` + 'x'.repeat(500)),
        exit_codes: Array.from({ length: 50 }, () => 1),
        evidence_paths: Array.from({ length: 50 }, (_, i) => `evidence/${i}.log`),
      }),
    );
    const raw = runSummary(file);
    expect(raw.attempts).toBe(1);
    // The ledger is an index, not an archive: entries are truncated, and the
    // event-log size cap would have rejected an unbounded record outright.
    const events = readEvents(file);
    const data = events[0]?.data as { commands: string[]; evidence_paths: string[] };
    expect(data.commands.length).toBeLessThanOrEqual(12);
    expect(data.evidence_paths.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify(events[0]), 'utf8')).toBeLessThanOrEqual(8192);
  });
});
