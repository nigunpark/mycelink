/**
 * Evidence paths are stored relative to the control root (root cause A5).
 *
 * The eval sealed and kept each workspace after the run, moving it. Records
 * that stored absolute output paths then pointed at nothing, and `feature
 * verify` reported every output missing. A relative path keeps resolving
 * wherever the control repository ends up; a legacy absolute record is
 * mapped back into this feature's directory only when that is provably safe.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { runVerification } from '../../src/evidence/runner.js';
import { checkEvidenceOutput, resolveEvidenceOutput } from '../../src/evidence/paths.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { featurePaths, nodeEvidenceDir } from '../../src/workspace/paths.js';
import type { EvidenceRecord } from '../../src/model/types.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

const NODE = `${FEATURE_ID}.core.publish.impl`;

async function cli(control: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await main([...asController(argv, control), '--control-root', control], io);
  return { code, out, err };
}

async function initFeature(): Promise<Portfolio> {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
  expect((await cli(p.control, ['feature', 'init', FEATURE_ID])).code).toBe(0);
  return p;
}

function passingRecord(p: Portfolio, kind: 'green' | 'regression' = 'green'): EvidenceRecord {
  return runVerification({
    kind,
    nodeId: NODE,
    repository: 'core',
    command: [process.execPath, '-e', 'console.log("ok 1")'],
    cwd: p.core,
    evidenceDir: nodeEvidenceDir(p.control, FEATURE_ID, NODE),
    pathBase: p.control,
  });
}

function setEvidence(control: string, record: EvidenceRecord): void {
  mutateState(featurePaths(control, FEATURE_ID).featureDir, (s) => {
    const runtime = s.nodes[NODE];
    if (runtime) runtime.evidence[record.kind] = record;
    return s;
  });
}

describe('evidence output paths', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await initFeature();
  });

  it('stores output_path relative to the control root, with forward slashes', () => {
    const record = passingRecord(p);
    expect(record.output_path).toBe(`features/${FEATURE_ID}/evidence/${NODE}/${NODE}.green.log`);
    expect(record.output_path).not.toMatch(/^[A-Za-z]:|^\//);
    const resolved = resolveEvidenceOutput(p.control, FEATURE_ID, record);
    expect(resolved).toEqual({ ok: true, path: resolve(p.control, record.output_path) });
    expect(readFileSync(resolve(p.control, record.output_path), 'utf8')).toContain('ok 1');
    expect(checkEvidenceOutput(p.control, FEATURE_ID, record)).toBeNull();
  });

  it('still verifies after the whole workspace is moved (sealed and kept)', async () => {
    setEvidence(p.control, passingRecord(p));
    const moved = join(p.root, '..', `${p.root.split(/[\\/]/).pop()}-sealed`);
    cpSync(p.root, moved, { recursive: true });
    const control = join(moved, 'control');
    const result = await cli(control, ['evidence', 'validate', FEATURE_ID, NODE, '--json']);
    const problems = (JSON.parse(result.out) as { problems: string[] }).problems;
    // red and regression were never recorded; the recorded green resolves.
    expect(problems.filter((x) => /green|OUTPUT|PATH/.test(x))).toEqual([]);
    expect(problems).toContain('MISSING_EVIDENCE: red');
  });

  it('maps a legacy absolute record from a moved workspace back into this feature, and migrates it', async () => {
    const record = passingRecord(p);
    const oldRoot = 'C:/old/sealed/run-1/control';
    setEvidence(p.control, { ...record, output_path: `${oldRoot}/${record.output_path}`, cwd: `${oldRoot}/x` });

    const resolved = resolveEvidenceOutput(p.control, FEATURE_ID, loadState(p.featureDir)!.data.nodes[NODE]!.evidence.green!);
    expect(resolved).toEqual({ ok: true, path: resolve(p.control, record.output_path) });

    const migrate = await cli(p.control, ['evidence', 'migrate', FEATURE_ID, '--json']);
    expect(migrate.code).toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[NODE]!.evidence.green!.output_path).toBe(record.output_path);
  });

  it('refuses traversal, foreign features and links instead of resolving them', () => {
    const record = passingRecord(p);
    const bad = (output_path: string): string | null =>
      checkEvidenceOutput(p.control, FEATURE_ID, { ...record, output_path });

    expect(bad('../../outside.log')).toMatch(/^UNSAFE_EVIDENCE_PATH/);
    expect(bad(`features/${FEATURE_ID}/../../outside.log`)).toMatch(/^UNSAFE_EVIDENCE_PATH/);
    expect(bad('features/OTHER-1/evidence/x.log')).toMatch(/^UNSAFE_EVIDENCE_PATH/);
    expect(bad(`C:/elsewhere/features/${FEATURE_ID}/../../../etc/passwd`)).toMatch(/^UNSAFE_EVIDENCE_PATH/);
    expect(bad('C:/elsewhere/no-feature-here.log')).toMatch(/^UNSAFE_EVIDENCE_PATH/);
    expect(bad('//server/share/features/x.log')).toMatch(/^UNSAFE_EVIDENCE_PATH/);
  });

  it('refuses an evidence file replaced by a link to somewhere else', (ctx) => {
    const record = passingRecord(p);
    const outside = join(p.root, 'outside.log');
    writeFileSync(outside, readFileSync(resolve(p.control, record.output_path)));
    const linked = `features/${FEATURE_ID}/evidence/${NODE}/linked.log`;
    try {
      symlinkSync(outside, resolve(p.control, linked), 'file');
    } catch {
      ctx.skip();
    }
    expect(checkEvidenceOutput(p.control, FEATURE_ID, { ...record, output_path: linked })).toMatch(
      /^UNSAFE_EVIDENCE_PATH/,
    );
  });

  it('detects an output whose content no longer matches its recorded hash', () => {
    const record = passingRecord(p);
    writeFileSync(resolve(p.control, record.output_path), 'edited after the fact\n');
    expect(checkEvidenceOutput(p.control, FEATURE_ID, record)).toMatch(/^OUTPUT_HASH_MISMATCH/);
  });

  it('feature verify reports a DONE node whose evidence output is missing', async () => {
    const record = passingRecord(p);
    mkdirSync(join(p.featureDir, 'evidence'), { recursive: true });
    mutateState(p.featureDir, (s) => {
      for (const runtime of Object.values(s.nodes)) runtime.state = 'DONE';
      const runtime = s.nodes[NODE]!;
      runtime.evidence = { red: { ...record, kind: 'red', exit_code: 1, red_reason: 'behaviour-missing' }, green: record, regression: { ...record, kind: 'regression', output_path: `features/${FEATURE_ID}/evidence/${NODE}/gone.log` } };
      return s;
    });
    const result = await cli(p.control, ['feature', 'verify', FEATURE_ID, '--json']);
    const problems = (JSON.parse(result.out) as { problems: string[] }).problems;
    expect(problems.some((x) => x.startsWith(`MISSING_OUTPUT: ${NODE} regression`))).toBe(true);
    expect(result.code).toBe(1);
  });
});
