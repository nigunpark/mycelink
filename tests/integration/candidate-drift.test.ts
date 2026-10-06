/**
 * Candidate self-drift (root cause A6).
 *
 * A candidate used to pin the control repository's HEAD while the
 * controller kept writing its own bookkeeping (STATE.json, events, the
 * candidate file itself) into that repository. Committing that bookkeeping
 * moved HEAD and invalidated the candidate it had just created. The
 * candidate now pins canonical content hashes of the control repository's
 * semantic inputs instead: bookkeeping cannot drift it, a real PRD, graph,
 * repository or config change still does, and repository SHAs are still
 * checked exactly.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import {
  computeManifestHash,
  createCandidate,
  loadCandidate,
  verifyCandidate,
  type CandidateManifest,
} from '../../src/git/candidate.js';
import { mutateState } from '../../src/state/feature-state.js';
import { writeTextAtomic } from '../../src/state/atomic-json.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

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

async function cli(p: Portfolio, argv: string[]): Promise<number> {
  const io: CliIo = { out: () => {}, err: () => {} };
  return main([...asController(argv, p.control), '--control-root', p.control], io);
}

describe('candidate pins control content, not control HEAD', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
    expect(await cli(p, ['feature', 'init', FEATURE_ID])).toBe(0);
    commitControl(p, 'feature scaffolding');
  });

  it('records canonical hashes of the semantic control inputs', () => {
    const m = cut(p);
    const paths = (m.control_inputs ?? []).map((x) => x.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `features/${FEATURE_ID}/PORTFOLIO-GRAPH.yaml`,
        `features/${FEATURE_ID}/PRD.md`,
        `features/${FEATURE_ID}/LOOPS.yaml`,
        'mycelink.config.json',
        'repositories.yaml',
      ]),
    );
    expect(paths.some((x) => /STATE\.json|events\.jsonl|candidates\/|evidence\//.test(x))).toBe(false);
  });

  it('survives committing the controller bookkeeping it just wrote (the eval failure)', () => {
    const m = cut(p);
    mutateState(p.featureDir, (s) => {
      s.current_candidate = m.candidate_id;
      s.candidates.push(m.candidate_id);
      return s;
    });
    mkdirSync(join(p.featureDir, 'evidence', 'x'), { recursive: true });
    writeFileSync(join(p.featureDir, 'evidence', 'x', 'log.txt'), 'output');
    appendFileSync(join(p.featureDir, 'DECISIONS.md'), '\n- note\n');
    commitControl(p, 'commit control state after the candidate');
    expect(codes(p, loadCandidate(p.featureDir, m.candidate_id))).toEqual([]);
  });

  it('ignores formatting-only changes to structured inputs', () => {
    const m = cut(p);
    const graph = YAML.parse(readFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph, null, 4));
    const config = JSON.parse(readFileSync(join(p.control, 'mycelink.config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(p.control, 'mycelink.config.json'), JSON.stringify(config));
    expect(codes(p, m)).toEqual([]);
  });

  it('detects a semantic PRD, graph, repository-manifest or config change', () => {
    const edits: [string, () => void][] = [
      ['PRD.md', () => appendFileSync(join(p.featureDir, 'PRD.md'), '\n- AC-4: something new.\n')],
      [
        'PORTFOLIO-GRAPH.yaml',
        () => {
          const g = YAML.parse(readFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8')) as { title: string };
          g.title = 'A different feature';
          writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(g));
        },
      ],
      [
        'repositories.yaml',
        () => {
          const r = YAML.parse(readFileSync(join(p.control, 'repositories.yaml'), 'utf8')) as {
            repositories: { commands: { test: string[] } }[];
          };
          r.repositories[0]!.commands.test = ['node', '-e', '0'];
          writeFileSync(join(p.control, 'repositories.yaml'), YAML.stringify(r));
        },
      ],
      [
        'mycelink.config.json',
        () => {
          const c = JSON.parse(readFileSync(join(p.control, 'mycelink.config.json'), 'utf8')) as Record<string, unknown>;
          writeFileSync(join(p.control, 'mycelink.config.json'), JSON.stringify({ ...c, allow_shell_commands: true }));
        },
      ],
    ];
    for (const [name, apply] of edits) {
      git(p.control, ['checkout', '--', '.']);
      const m = cut(p);
      apply();
      expect(`${name}: ${codes(p, m).join(',')}`).toMatch(new RegExp(`^${name.replace('.', '\\.')}: .*CONTROL_INPUT_DRIFT`));
    }
  });

  it('does not ignore arbitrary control drift: a tracked deploy script changing is drift', () => {
    const m = cut(p);
    appendFileSync(join(p.control, 'scripts', 'deploy-candidate.mjs'), '\n// changed after the cut\n');
    commitControl(p, 'tweak deploy script');
    expect(codes(p, m)).toContain('CONTROL_INPUT_DRIFT');
  });

  it('ignores bookkeeping of other features and rotated logs too', () => {
    const m = cut(p);
    const other = join(p.control, 'features', 'FEAT-777');
    mkdirSync(join(other, 'evidence'), { recursive: true });
    writeFileSync(join(other, 'STATE.json'), '{}');
    writeFileSync(join(other, 'evidence', 'x.log'), 'x');
    writeFileSync(join(p.featureDir, 'events.00001.jsonl'), '{}\n');
    commitControl(p, 'other feature state');
    expect(codes(p, m)).toEqual([]);
  });

  it('detects a new semantic input (an added E2E scenario or PLAN)', () => {
    const m = cut(p);
    mkdirSync(join(p.featureDir, 'e2e'), { recursive: true });
    writeFileSync(join(p.featureDir, 'e2e', 'E2E-new.yaml'), 'id: E2E-new\n');
    writeFileSync(join(p.featureDir, 'PLAN.md'), '# plan\n');
    const found = codes(p, m);
    expect(found.filter((c) => c === 'CONTROL_INPUT_ADDED')).toHaveLength(2);
  });

  it('still detects repository SHA drift exactly', () => {
    const m = cut(p);
    writeFileSync(join(p.api, 'late.js'), '1');
    commitAll(p.api, 'late change');
    expect(codes(p, m)).toContain('REPOSITORY_SHA_DRIFT');
  });

  it('a legacy candidate without content hashes keeps the strict HEAD pin', () => {
    const m = cut(p);
    const { manifest_sha256: _h, control_inputs: _c, ...body } = m;
    const legacy = { ...body } as Omit<CandidateManifest, 'manifest_sha256'>;
    const manifest = { ...legacy, manifest_sha256: computeManifestHash(legacy) } as CandidateManifest;
    writeTextAtomic(join(p.featureDir, 'candidates', `${m.candidate_id}.yaml`), YAML.stringify(manifest));
    expect(codes(p, loadCandidate(p.featureDir, m.candidate_id))).toEqual([]);
    writeFileSync(join(p.control, 'README.md'), '# moved on\n');
    commitControl(p, 'unrelated control commit');
    expect(codes(p, loadCandidate(p.featureDir, m.candidate_id))).toContain('CONTROL_SHA_DRIFT');
  });
});
