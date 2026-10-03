import { describe, expect, it } from 'vitest';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import type { EvidenceRecord, FeatureState_, PortfolioGraph } from '../../src/model/types.js';
import { initialState } from '../../src/state/feature-state.js';
import {
  ContextPackTooLargeError,
  buildContextPack,
  packBytes,
  type BuildContextPackArgs,
} from '../../src/sessions/context-pack.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

const GRAPH = clone(VALID_GRAPH) as unknown as PortfolioGraph;
const NODE = 'FEAT-101.api.consume.impl';

function state(): FeatureState_ {
  const s = initialState(GRAPH, 'a'.repeat(64));
  s.nodes[NODE]!.state = 'CLAIMED';
  s.nodes[NODE]!.claim = {
    claim_id: 'claim-1',
    owner: 'controller',
    worktree: 'C:/wt/api',
    branch: 'wip/FEAT-101/api.consume.impl',
    claimed_at: '2026-01-01T00:00:00.000Z',
  };
  return s;
}

function baseArgs(): BuildContextPackArgs {
  return {
    graph: GRAPH,
    state: state(),
    nodeId: NODE,
    claimId: 'claim-1',
    worktree: 'C:/wt/api',
    branch: 'wip/FEAT-101/api.consume.impl',
    contractHashes: { 'contracts/order-status.schema.json': 'c'.repeat(64) },
    maxBytes: 16_384,
    now: '2026-01-01T00:00:00.000Z',
  };
}

describe('context pack', () => {
  it('produces a schema-valid pack', () => {
    const pack = buildContextPack(baseArgs());
    expect(validateAgainstSchema('context-pack', pack)).toEqual([]);
  });

  it('carries the node contract, fence, verifiers and next gate', () => {
    const pack = buildContextPack(baseArgs());
    expect(pack.node_id).toBe(NODE);
    expect(pack.repository).toBe('api');
    expect(pack.allowed_paths).toEqual(['src/**']);
    expect(pack.verification_commands[0]?.command).toEqual([
      'node',
      '--test',
      'tests/consume.test.js',
    ]);
    expect(pack.next_required_gate).toBe('RED_VERIFIED');
    expect(pack.budget.max_turns).toBe(30);
    expect(pack.budget.attempt).toBe(1);
  });

  it('includes only acceptance criteria the node actually covers', () => {
    const pack = buildContextPack(baseArgs());
    expect(pack.acceptance_criteria.map((a) => a.id)).toEqual(['AC-2']);
  });

  it('carries contract inputs as path plus hash, never content', () => {
    const pack = buildContextPack(baseArgs());
    expect(pack.contracts).toEqual([
      {
        path: 'contracts/order-status.schema.json',
        sha256: 'c'.repeat(64),
        direction: 'input',
      },
    ]);
  });

  it('advances the next gate as evidence accumulates', () => {
    const args = baseArgs();
    args.state.nodes[NODE]!.state = 'RED_VERIFIED';
    expect(buildContextPack(args).next_required_gate).toBe('GREEN_VERIFIED');
    args.state.nodes[NODE]!.state = 'GREEN_VERIFIED';
    expect(buildContextPack(args).next_required_gate).toBe('REGRESSION_VERIFIED');
  });

  it('passes the last failure fingerprint but no log body', () => {
    const args = baseArgs();
    args.state.nodes[NODE]!.last_failure_fingerprint = 'assert:consume-missing';
    const ev: EvidenceRecord = {
      kind: 'red',
      node_id: NODE,
      command: ['node', '--test'],
      exit_code: 1,
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:00:01.000Z',
      cwd: 'C:/wt/api',
      repository: 'api',
      commit_sha: 'a'.repeat(40),
      output_path: 'evidence/red.log',
      output_sha256: 'b'.repeat(64),
      failure_fingerprint: 'assert:consume-missing',
      red_reason: 'behaviour-missing',
    };
    args.state.nodes[NODE]!.evidence.red = ev;

    const pack = buildContextPack(args);
    expect(pack.last_failure_fingerprint).toBe('assert:consume-missing');
    expect(pack.latest_evidence).toEqual([
      { kind: 'red', exit_code: 1, output_path: 'evidence/red.log', output_sha256: 'b'.repeat(64) },
    ]);
    expect(JSON.stringify(pack)).not.toContain('--test\n');
  });

  it('never embeds file bodies, diffs or transcripts', () => {
    const pack = buildContextPack(baseArgs());
    const text = JSON.stringify(pack);
    for (const forbidden of ['diff --git', '<<<<<<<', 'Binary file', 'data:image', 'base64,']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('is deterministic for identical inputs', () => {
    expect(JSON.stringify(buildContextPack(baseArgs()))).toBe(
      JSON.stringify(buildContextPack(baseArgs())),
    );
  });

  it('stays inside the declared byte budget', () => {
    const pack = buildContextPack(baseArgs());
    expect(packBytes(pack)).toBeLessThanOrEqual(16_384);
    expect(pack.byte_budget).toBe(16_384);
  });

  it('drops optional memory recall before required fields when space runs out', () => {
    const args = baseArgs();
    args.maxBytes = 2400;
    args.memory = Array.from({ length: 40 }, (_, i) => ({
      id: `mem-${i}`,
      type: 'procedure',
      status: 'verified',
      summary: 'x'.repeat(200),
      path: `.llmwiki/procedures/mem-${i}.md`,
    }));
    const pack = buildContextPack(args);
    expect(packBytes(pack)).toBeLessThanOrEqual(2400);
    expect(pack.memory?.length ?? 0).toBeLessThan(40);
    // Required fields survive the trim.
    expect(pack.allowed_paths).toEqual(['src/**']);
    expect(pack.verification_commands).toHaveLength(1);
  });

  it('throws rather than silently truncating a required field', () => {
    const args = baseArgs();
    args.maxBytes = 200;
    expect(() => buildContextPack(args)).toThrow(ContextPackTooLargeError);
  });

  it('includes the worker rules that bound a session', () => {
    const pack = buildContextPack(baseArgs());
    const rules = (pack.rules ?? []).join('\n');
    expect(rules).toMatch(/one node/i);
    expect(rules).toMatch(/NEEDS_DECISION/);
    expect(rules).toMatch(/not spawn/i);
  });
});
