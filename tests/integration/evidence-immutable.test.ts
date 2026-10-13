/**
 * Gate evidence is immutable from the moment it is written (the CSET-202
 * rerun).
 *
 * The cli's review rework ran its red gate twice. Every run wrote the same
 * `<node>.red.log` and `<node>.red.results.json`, so the second run replaced
 * the bytes of the first while the first run's record (kept as the node's
 * RED) still named that path and hash. R002 passed, C001 was cut, and
 * delivery refused it: OUTPUT_HASH_MISMATCH. Nothing about the product was
 * wrong; the evidence store had overwritten what a record still referenced.
 *
 * Here every invocation's output and results land at a content-addressed
 * path that is never written again: a later run, of any gate, leaves every
 * earlier record verifying, a planted file or link is never written through
 * or over, and the legacy canonical names are only ever read.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { runVerification } from '../../src/evidence/runner.js';
import { checkEvidenceOutput } from '../../src/evidence/paths.js';
import { nodeEvidenceDir } from '../../src/workspace/paths.js';
import type { EvidenceRecord } from '../../src/model/types.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

const NODE = `${FEATURE_ID}.core.publish.impl`;
const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

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

/** A tiny "test runner": prints its verdict and writes a vitest-json report of one test with that status. */
function reporter(dir: string): string {
  const file = join(dir, 'report-writer.cjs');
  writeFileSync(
    file,
    [
      "const fs = require('node:fs');",
      'const [status, out] = process.argv.slice(2);',
      "console.log(status === 'failed' ? 'FAIL tests/publish.test.mjs > publishes AssertionError: expected true' : 'ok 1 publishes');",
      "fs.writeFileSync(out, JSON.stringify({ testResults: [{ name: 'tests/publish.test.mjs', status, assertionResults: [{ title: 'publishes', ancestorTitles: [], status, failureMessages: status === 'failed' ? ['AssertionError: expected true to be false'] : [] }] }] }));",
      "process.exit(status === 'failed' ? 1 : 0);",
    ].join('\n'),
  );
  return file;
}

function gate(p: Portfolio, kind: 'red' | 'green', status: 'passed' | 'failed', script: string): EvidenceRecord {
  return runVerification({
    kind,
    nodeId: NODE,
    repository: 'core',
    command: [process.execPath, script, status, '${REPORT}'],
    report: { format: 'vitest-json' },
    cwd: p.core,
    evidenceDir: nodeEvidenceDir(p.control, FEATURE_ID, NODE),
    pathBase: p.control,
    ...(kind === 'red' ? { expectExit: -1 } : {}),
  });
}

const fileOf = (p: Portfolio, rel: string): string => resolve(p.control, rel);

describe('immutable gate evidence', () => {
  let p: Portfolio;
  let script: string;
  beforeEach(async () => {
    p = await initFeature();
    script = reporter(makeTmpDir('evidence-immutable-'));
  });

  it('a second run of the same gate leaves the first record verifying, output and results', () => {
    const first = gate(p, 'red', 'failed', script);
    const second = gate(p, 'red', 'passed', script);
    expect(second.output_sha256).not.toBe(first.output_sha256);
    expect(second.output_path).not.toBe(first.output_path);
    expect(second.results?.path).not.toBe(first.results?.path);
    // Each record still names exactly the bytes its run wrote.
    expect(checkEvidenceOutput(p.control, FEATURE_ID, first)).toBeNull();
    expect(checkEvidenceOutput(p.control, FEATURE_ID, second)).toBeNull();
    expect(sha256(readFileSync(fileOf(p, first.results!.path)))).toBe(first.results!.sha256);
    expect(sha256(readFileSync(fileOf(p, second.results!.path)))).toBe(second.results!.sha256);
    // The paths are content-addressed by the bytes they hold.
    expect(basename(first.output_path)).toContain(first.output_sha256.slice(0, 16));
    expect(basename(first.results!.path)).toContain(first.results!.sha256.slice(0, 16));
  });

  it('never writes the legacy canonical names a record from an earlier release may still name', () => {
    const dir = nodeEvidenceDir(p.control, FEATURE_ID, NODE);
    mkdirSync(dir, { recursive: true });
    const legacy = join(dir, `${NODE}.red.log`);
    const legacyResults = join(dir, `${NODE}.red.results.json`);
    writeFileSync(legacy, 'the RED an earlier release recorded\n');
    writeFileSync(legacyResults, '{"schema":"mycelink-test-results/1","results":[]}\n');
    const record = gate(p, 'red', 'failed', script);
    expect(readFileSync(legacy, 'utf8')).toBe('the RED an earlier release recorded\n');
    expect(readFileSync(legacyResults, 'utf8')).toBe('{"schema":"mycelink-test-results/1","results":[]}\n');
    expect(record.output_path).not.toBe(`features/${FEATURE_ID}/evidence/${NODE}/${NODE}.red.log`);
  });

  it('the same bytes twice are one artifact, never rewritten; no temp file is left behind', () => {
    const a = runVerification({ kind: 'green', nodeId: NODE, repository: 'core', command: [process.execPath, '-e', 'console.log("same")'], cwd: p.core, evidenceDir: nodeEvidenceDir(p.control, FEATURE_ID, NODE), pathBase: p.control });
    const before = lstatSync(fileOf(p, a.output_path)).mtimeMs;
    // Same command, same bytes: the store keys on them.
    const b = runVerification({ kind: 'green', nodeId: NODE, repository: 'core', command: [process.execPath, '-e', 'console.log("same")'], cwd: p.core, evidenceDir: nodeEvidenceDir(p.control, FEATURE_ID, NODE), pathBase: p.control });
    expect(b.output_sha256).toBe(a.output_sha256);
    expect(b.output_path).toBe(a.output_path);
    expect(lstatSync(fileOf(p, a.output_path)).mtimeMs).toBe(before);
    expect(checkEvidenceOutput(p.control, FEATURE_ID, a)).toBeNull();
    expect(checkEvidenceOutput(p.control, FEATURE_ID, b)).toBeNull();
    const left = readdirSync(nodeEvidenceDir(p.control, FEATURE_ID, NODE)).filter((n) => n.endsWith('.tmp') || n.includes('.tmp-'));
    expect(left).toEqual([]);
  });

  it('a file or link planted at the content-addressed name is never written through or over', (ctx) => {
    const dir = nodeEvidenceDir(p.control, FEATURE_ID, NODE);
    mkdirSync(dir, { recursive: true });
    // The bytes the next run will write are known only after it ran: plant at every name the first run used, then run again identically.
    const first = gate(p, 'green', 'passed', script);
    const victim = join(makeTmpDir('evidence-victim-'), 'victim.txt');
    writeFileSync(victim, 'untouched');
    const at = fileOf(p, first.output_path);
    const planted = readFileSync(at);
    // Replace the artifact with a link to somewhere else (a tamper): a later identical run must not write through it.
    rmSync(at);
    try {
      symlinkSync(victim, at, 'file');
    } catch {
      ctx.skip();
    }
    const again = gate(p, 'green', 'passed', script);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(at).isSymbolicLink()).toBe(true);
    // Whatever the second run wrote is a regular file of its own that verifies.
    expect(checkEvidenceOutput(p.control, FEATURE_ID, again)).toBeNull();
    void planted;
  });

  it('a foreign file at a content-addressed name is left as it is; the run lands elsewhere and verifies', () => {
    const first = gate(p, 'green', 'passed', script);
    const at = fileOf(p, first.output_path);
    writeFileSync(at, 'someone else wrote here\n');
    const again = gate(p, 'green', 'passed', script);
    expect(readFileSync(at, 'utf8')).toBe('someone else wrote here\n');
    expect(checkEvidenceOutput(p.control, FEATURE_ID, again)).toBeNull();
    expect(existsSync(fileOf(p, again.output_path))).toBe(true);
  });
});
