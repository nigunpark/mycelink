/**
 * Candidate manifest tampering.
 *
 * The manifest hash is not a signature: anyone who can edit the file can also
 * recompute it. Integrity therefore comes from re-checking every bound fact
 * against the repositories themselves, and from refusing a manifest whose
 * identity does not match where it is stored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { commitAll, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import {
  candidateFile,
  computeManifestHash,
  createCandidate,
  loadCandidate,
  verifyCandidate,
  type CandidateManifest,
} from '../../src/git/candidate.js';

afterEach(() => cleanupTmpRoots());

function setup() {
  const root = makeTmpDir('tamper-');
  const control = join(root, 'control');
  makeGitRepo(control, { files: { 'contracts/c.json': '{}\n', 'README.md': '# c\n' } });
  const core = join(root, 'core');
  makeGitRepo(core, { files: { 'a.js': 'v1\n' } });
  const featureDir = join(control, 'features', 'FEAT-7');
  mkdirSync(join(featureDir, 'candidates'), { recursive: true });
  const refs = [{ name: 'core', path: core, branch: 'main' }];
  const first = commitAll; // keep import used for later commits
  void first;
  const manifest = createCandidate({ controlRepo: control, featureDir, featureId: 'FEAT-7', repositories: refs, contracts: ['contracts/c.json'] });
  return { root, control, core, featureDir, refs, manifest };
}

function rehash(m: CandidateManifest): CandidateManifest {
  const { manifest_sha256: _drop, ...body } = m;
  void _drop;
  return { ...body, manifest_sha256: computeManifestHash(body) } as CandidateManifest;
}

describe('candidate tampering', () => {
  it('detects a bound SHA swapped for an older real commit even when the hash is recomputed', () => {
    const s = setup();
    const original = s.manifest.repositories['core']?.sha as string;
    writeFiles(s.core, { 'a.js': 'v2\n' });
    const newer = commitAll(s.core, 'v2');
    const fresh = createCandidate({ controlRepo: s.control, featureDir: s.featureDir, featureId: 'FEAT-7', repositories: s.refs, contracts: ['contracts/c.json'] });
    expect(fresh.repositories['core']?.sha).toBe(newer);

    const forged = structuredClone(fresh);
    forged.repositories['core']!.sha = original;
    const result = verifyCandidate(rehash(forged), { controlRepo: s.control, repositories: s.refs });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).not.toContain('MANIFEST_HASH_MISMATCH');
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('detects a forged contract hash even when the manifest hash is recomputed', () => {
    const s = setup();
    const forged = structuredClone(s.manifest);
    (forged.contracts[0] as { sha256: string }).sha256 = '0'.repeat(64);
    const result = verifyCandidate(rehash(forged), { controlRepo: s.control, repositories: s.refs });
    expect(result.problems.map((p) => p.code)).toContain('CONTRACT_HASH_DRIFT');
  });

  it('detects an on-disk edit of the YAML file', () => {
    const s = setup();
    const file = candidateFile(s.featureDir, s.manifest.candidate_id);
    const doc = YAML.parse(readFileSync(file, 'utf8')) as CandidateManifest;
    doc.repositories['core']!.sha = 'e'.repeat(40);
    writeFileSync(file, YAML.stringify(doc));
    const loaded = loadCandidate(s.featureDir, s.manifest.candidate_id);
    const result = verifyCandidate(loaded, { controlRepo: s.control, repositories: s.refs });
    expect(result.problems.map((p) => p.code)).toContain('MANIFEST_HASH_MISMATCH');
  });

  it('refuses a manifest copied under another candidate id', () => {
    const s = setup();
    const src = candidateFile(s.featureDir, s.manifest.candidate_id);
    copyFileSync(src, candidateFile(s.featureDir, 'FEAT-7-C009'));
    expect(() => loadCandidate(s.featureDir, 'FEAT-7-C009')).toThrow(/CANDIDATE_ID_MISMATCH/);
  });

  it('refuses a manifest for another feature', () => {
    const s = setup();
    const other = join(s.control, 'features', 'FEAT-8', 'candidates');
    mkdirSync(other, { recursive: true });
    copyFileSync(candidateFile(s.featureDir, s.manifest.candidate_id), join(other, `${s.manifest.candidate_id}.yaml`));
    expect(() => loadCandidate(join(s.control, 'features', 'FEAT-8'), s.manifest.candidate_id)).toThrow(/CANDIDATE_FEATURE_MISMATCH/);
  });
});
