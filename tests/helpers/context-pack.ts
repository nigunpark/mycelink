/**
 * A minimal, schema-valid context pack for adapter-level tests that do not
 * build a whole portfolio graph.
 */
import { writeFileSync } from 'node:fs';
import type { ContextPack } from '../../src/sessions/context-pack.js';
import { WORKER_RULES } from '../../src/sessions/context-pack.js';

export function minimalPack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    schema_version: 1,
    feature_id: 'FEAT-101',
    node_id: 'FEAT-101.core.publish.impl',
    claim_id: 'claim-1',
    generated_at: '2026-10-04T00:00:00.000Z',
    repository: 'core',
    worktree: null,
    branch: 'wip/FEAT-101/core.publish.impl',
    node_contract: { node_type: 'implementation', goal: 'implementation for "Publish".', capability: null },
    acceptance_criteria: [{ id: 'AC-1', text: 'Publishing emits JOB_RESULT_V2.' }],
    allowed_paths: ['src/**', 'tests/**'],
    forbidden_paths: [],
    contracts: [],
    last_checkpoint_sha: null,
    latest_evidence: [],
    last_failure_fingerprint: null,
    verification_commands: [{ id: 'targeted', command: ['node', 'tests/run.mjs'] }],
    next_required_gate: 'RED_VERIFIED',
    budget: { max_turns: 10, max_wall_clock_minutes: 5, max_attempts: 3, attempt: 1 },
    byte_budget: 16384,
    rules: [...WORKER_RULES],
    ...overrides,
  };
}

export function writePack(file: string, pack: unknown): void {
  writeFileSync(file, JSON.stringify(pack, null, 2) + '\n', 'utf8');
}
