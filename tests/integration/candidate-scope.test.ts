/**
 * What a release candidate binds, and what it pins.
 *
 * A candidate for a multi-repository feature binds every registered
 * repository at its exact current integration SHA (a repository the feature
 * never touched is bound at its base), so delivering it moves the whole
 * portfolio or nothing. Its control inputs are the global configuration and
 * the target feature's own semantic files: another feature planned later
 * does not drift it, while a change to this feature or to the global
 * configuration does.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { controlInputs, createCandidate, loadCandidate, verifyCandidate, type CandidateManifest } from '../../src/git/candidate.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { integrationBranchName } from '../../src/git/worktree.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

const OTHER = 'FEAT-902';

function refs(p: Portfolio) {
  return [
    { name: 'core', path: p.core, branch: 'main' },
    { name: 'api', path: p.api, branch: 'main' },
    { name: 'web', path: p.app, branch: 'main' },
  ];
}

function cut(p: Portfolio): CandidateManifest {
  return createCandidate({
    controlRepo: p.control,
    featureDir: p.featureDir,
    featureId: FEATURE_ID,
    repositories: refs(p),
    contracts: ['contracts/order-status.json'],
  });
}

function codes(p: Portfolio, manifest: CandidateManifest): string[] {
  return verifyCandidate(manifest, { controlRepo: p.control, repositories: refs(p) }).problems.map((x) => x.code);
}

async function cli(p: Portfolio, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await main([...asController(argv, p.control), '--control-root', p.control], io);
  return { code, out, err };
}

function planOther(p: Portfolio): void {
  const dir = join(p.control, 'features', OTHER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), `# ${OTHER}\n\n- AC-1: something else.\n`);
  writeFileSync(join(dir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify({ ...portfolioGraph(), feature_id: OTHER }, { lineWidth: 0 }));
  writeFileSync(join(dir, 'LOOPS.yaml'), 'loops: []\n');
}

describe('candidate control inputs are scoped to global configuration and the target feature', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
    commitControl(p, 'feature scaffolding');
  });

  it('pins no other feature files', () => {
    planOther(p);
    commitControl(p, 'plan another feature');
    const paths = controlInputs(p.control, FEATURE_ID).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining([`features/${FEATURE_ID}/PRD.md`, 'mycelink.config.json', 'repositories.yaml']));
    expect(paths.filter((x) => x.startsWith(`features/${OTHER}/`))).toEqual([]);
  });

  it('another feature planned after the cut does not invalidate the candidate', () => {
    const m = cut(p);
    planOther(p);
    commitControl(p, 'plan another feature');
    expect(codes(p, m)).toEqual([]);
  });

  it('a change to the target feature still drifts it', () => {
    const m = cut(p);
    writeFileSync(join(p.featureDir, 'PRD.md'), '# changed\n');
    writeFileSync(join(p.featureDir, 'NOTES.md'), 'new input\n');
    commitControl(p, 'edit the feature');
    expect(codes(p, m)).toEqual(expect.arrayContaining(['CONTROL_INPUT_DRIFT', 'CONTROL_INPUT_ADDED']));
  });

  it('a change to global configuration still drifts it', () => {
    const m = cut(p);
    writeFileSync(join(p.control, 'contracts', 'refund.json'), '{"version":1}\n');
    commitControl(p, 'new global contract');
    expect(codes(p, m)).toContain('CONTROL_INPUT_ADDED');
    const m2 = cut(p);
    const repos = YAML.parse(git(p.control, ['show', 'HEAD:repositories.yaml'])) as { repositories: { description?: string }[] };
    repos.repositories[0]!.description = 'changed';
    writeFileSync(join(p.control, 'repositories.yaml'), YAML.stringify(repos));
    commitControl(p, 'edit the repository manifest');
    expect(codes(p, m2)).toContain('CONTROL_INPUT_DRIFT');
  });
});

describe('a candidate binds the whole registered portfolio', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
    commitControl(p, 'feature scaffolding');
    // Only core has integrated work; api and web were never touched.
    git(p.core, ['checkout', '-q', '-b', integrationBranchName(FEATURE_ID)]);
    writeFileSync(join(p.core, 'src', 'publish.js'), 'export const JOB_RESULT_V2 = true;\n');
    commitAll(p.core, 'core work');
    git(p.core, ['checkout', '-q', 'main']);
    mutateState(p.featureDir, (s) => {
      for (const rt of Object.values(s.nodes)) rt.state = 'DONE';
      return s;
    });
  });

  it('candidate create binds untouched repositories at their base', async () => {
    const r = await cli(p, ['candidate', 'create', FEATURE_ID, '--json']);
    expect(r.err).toBe('');
    const manifest = JSON.parse(r.out) as CandidateManifest;
    expect(Object.keys(manifest.repositories).sort()).toEqual(['api', 'core', 'web']);
    expect(manifest.repositories['core']!.sha).toBe(git(p.core, ['rev-parse', integrationBranchName(FEATURE_ID)]));
    expect(manifest.repositories['api']!.sha).toBe(git(p.api, ['rev-parse', 'main']));
    expect(manifest.repositories['web']!.sha).toBe(git(p.app, ['rev-parse', 'main']));
    expect((await cli(p, ['candidate', 'verify', FEATURE_ID])).code).toBe(0);
  });

  it('verify refuses a candidate that binds only part of the portfolio', async () => {
    const partial = createCandidate({
      controlRepo: p.control,
      featureDir: p.featureDir,
      featureId: FEATURE_ID,
      repositories: [{ name: 'core', path: p.core, branch: integrationBranchName(FEATURE_ID) }],
      contracts: [],
    });
    mutateState(p.featureDir, (s) => {
      s.candidates.push(partial.candidate_id);
      s.current_candidate = partial.candidate_id;
      return s;
    });
    const v = await cli(p, ['candidate', 'verify', FEATURE_ID, partial.candidate_id, '--json']);
    expect(v.code).toBe(1);
    expect(v.out).toContain('REPOSITORY_NOT_BOUND');
    const d = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(d.code).toBe(1);
    expect(d.err).toContain('REPOSITORY_NOT_BOUND');
    expect(loadCandidate(p.featureDir, partial.candidate_id).repositories['api']).toBeUndefined();
    expect(loadState(p.featureDir)!.data.feature_state).not.toBe('COMPLETED');
  });
});
