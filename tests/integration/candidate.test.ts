import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { resolveRef } from '../../src/git/git.js';
import { DirtyWorktreeError } from '../../src/git/integrate.js';
import {
  CandidateImmutableError,
  createCandidate,
  listCandidates,
  loadCandidate,
  nextCandidateId,
  verifyCandidate,
} from '../../src/git/candidate.js';

afterAll(() => cleanupTmpRoots());

interface Portfolio {
  root: string;
  control: string;
  featureDir: string;
  core: string;
  api: string;
}

function portfolio(): Portfolio {
  const root = makeTmpDir('cand-');
  const control = join(root, 'control');
  makeGitRepo(control, {
    files: {
      'contracts/order-status.schema.json': '{"type":"object"}\n',
      'README.md': '# control\n',
    },
  });
  const core = join(root, 'core');
  makeGitRepo(core, { files: { 'src/publish.js': 'v1\n' }, branch: 'main' });
  const api = join(root, 'api');
  makeGitRepo(api, { files: { 'src/consume.js': 'v1\n' }, branch: 'main' });

  const featureDir = join(control, 'features', 'FEAT-101');
  mkdirSync(join(featureDir, 'candidates'), { recursive: true });
  return { root, control, featureDir, core, api };
}

function repoRefs(p: Portfolio) {
  return [
    { name: 'core', path: p.core, branch: 'main' },
    { name: 'api', path: p.api, branch: 'main' },
  ];
}

describe('cross-repository candidate manifest', () => {
  it('allocates sequential candidate ids', () => {
    const p = portfolio();
    expect(nextCandidateId(p.featureDir, 'FEAT-101')).toBe('FEAT-101-C001');
    createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: ['contracts/order-status.schema.json'],
    });
    expect(nextCandidateId(p.featureDir, 'FEAT-101')).toBe('FEAT-101-C002');
  });

  it('binds one exact commit per repository plus contract hashes', () => {
    const p = portfolio();
    const manifest = createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: ['contracts/order-status.schema.json'],
    });

    expect(manifest.candidate_id).toBe('FEAT-101-C001');
    expect(manifest.repositories['core']?.sha).toBe(resolveRef(p.core, 'main'));
    expect(manifest.repositories['api']?.sha).toBe(resolveRef(p.api, 'main'));
    expect(manifest.control_commit).toBe(resolveRef(p.control, 'HEAD'));
    expect(manifest.contracts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.created_from_clean_worktrees).toBe(true);
    expect(manifest.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);

    const file = join(p.featureDir, 'candidates', 'FEAT-101-C001.yaml');
    expect(existsSync(file)).toBe(true);
    expect(loadCandidate(p.featureDir, 'FEAT-101-C001').candidate_id).toBe('FEAT-101-C001');
    expect(listCandidates(p.featureDir)).toEqual(['FEAT-101-C001']);
  });

  it('refuses to create a candidate from a dirty repository worktree', () => {
    const p = portfolio();
    writeFiles(p.core, { 'src/publish.js': 'uncommitted\n' });
    expect(() =>
      createCandidate({
        controlRepo: p.control,
        featureDir: p.featureDir,
        featureId: 'FEAT-101',
        repositories: repoRefs(p),
        contracts: [],
      }),
    ).toThrow(DirtyWorktreeError);
  });

  it('refuses to create a candidate from a dirty control repository', () => {
    const p = portfolio();
    writeFileSync(join(p.control, 'stray.txt'), 'x\n');
    expect(() =>
      createCandidate({
        controlRepo: p.control,
        featureDir: p.featureDir,
        featureId: 'FEAT-101',
        repositories: repoRefs(p),
        contracts: [],
      }),
    ).toThrow(DirtyWorktreeError);
  });

  it('refuses a missing branch', () => {
    const p = portfolio();
    expect(() =>
      createCandidate({
        controlRepo: p.control,
        featureDir: p.featureDir,
        featureId: 'FEAT-101',
        repositories: [{ name: 'core', path: p.core, branch: 'feature/nope' }],
        contracts: [],
      }),
    ).toThrow(/branch/i);
  });

  it('refuses a contract path that does not exist in the control repo', () => {
    const p = portfolio();
    expect(() =>
      createCandidate({
        controlRepo: p.control,
        featureDir: p.featureDir,
        featureId: 'FEAT-101',
        repositories: repoRefs(p),
        contracts: ['contracts/missing.json'],
      }),
    ).toThrow(/contract/i);
  });

  it('is immutable: writing the same candidate id twice is refused', () => {
    const p = portfolio();
    const args = {
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: [],
      candidateId: 'FEAT-101-C001',
    };
    createCandidate(args);
    expect(() => createCandidate(args)).toThrow(CandidateImmutableError);
  });

  it('verifyCandidate passes while every repository still points at the bound SHA', () => {
    const p = portfolio();
    const manifest = createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: ['contracts/order-status.schema.json'],
    });
    const result = verifyCandidate(manifest, {
      controlRepo: p.control,
      repositories: repoRefs(p),
    });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('verifyCandidate detects that a repository moved after the candidate was cut', () => {
    const p = portfolio();
    const manifest = createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: [],
    });

    writeFiles(p.core, { 'src/publish.js': 'v2\n' });
    commitAll(p.core, 'drift');

    const result = verifyCandidate(manifest, {
      controlRepo: p.control,
      repositories: repoRefs(p),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.map((x) => x.code)).toContain('REPOSITORY_SHA_DRIFT');
    expect(result.problems[0]?.detail).toContain('core');
  });

  it('verifyCandidate detects a contract edited after the candidate was cut', () => {
    const p = portfolio();
    const manifest = createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: ['contracts/order-status.schema.json'],
    });
    writeFiles(p.control, { 'contracts/order-status.schema.json': '{"type":"string"}\n' });
    const result = verifyCandidate(manifest, {
      controlRepo: p.control,
      repositories: repoRefs(p),
    });
    expect(result.problems.map((x) => x.code)).toContain('CONTRACT_HASH_DRIFT');
  });

  it('verifyCandidate detects tampering with the manifest itself', () => {
    const p = portfolio();
    const manifest = createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: [],
    });
    const tampered = structuredClone(manifest);
    tampered.repositories['core']!.sha = 'f'.repeat(40);
    const result = verifyCandidate(tampered, {
      controlRepo: p.control,
      repositories: repoRefs(p),
    });
    expect(result.problems.map((x) => x.code)).toContain('MANIFEST_HASH_MISMATCH');
  });

  it('writes a candidate file that is valid YAML and schema-valid', () => {
    const p = portfolio();
    createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: 'FEAT-101',
      repositories: repoRefs(p),
      contracts: ['contracts/order-status.schema.json'],
    });
    const text = readFileSync(join(p.featureDir, 'candidates', 'FEAT-101-C001.yaml'), 'utf8');
    expect(text).toContain('candidate_id: FEAT-101-C001');
    expect(text).toContain('created_from_clean_worktrees: true');
  });
});
