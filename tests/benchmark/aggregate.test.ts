/**
 * verify-run --aggregate on a `claude plugin eval` result, modelled on a
 * harness output (tests/benchmark/fixtures/plugin-eval: the eval JSON of a
 * real run, and a hand-authored head of out/trace.jsonl and worker
 * transcript, machine paths as placeholders). The harness keeps a run's sandbox as
 * `<sandbox>/out/trace.jsonl`, `<sandbox>/config/projects/**` and the
 * workspace the agent saw as `<sandbox>/home/cwd` at
 * `<sandbox>/sealed/home/cwd`. The verifier derives exactly that workspace,
 * refuses an ambiguous or decoyed sandbox, and scans every transcript —
 * the workers' too — for evaluator access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY, TOY_CASE, TOY_PRD, commitFiles, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { buildWorkspace } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { main as verifyRunMain } from '../../evals-public-projects/tools/verify-run.mjs';

afterAll(() => cleanupTmpRoots());

const FIXTURE = join(REPO_ROOT, 'tests', 'benchmark', 'fixtures', 'plugin-eval');
const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
const fwd = (p: string) => p.replace(/\\/g, '/');

let toy: Toy;
let project: any;
let prd: any;

beforeAll(async () => {
  ({ toy, project, prd } = await preparedToy());
}, 300_000);

/** A workspace the scaffold would build, delivered test-first (or left untouched). */
async function workspaceAt(target: string, deliver = true): Promise<void> {
  await buildWorkspace({ project, prd, target, home: makeTmpDir('bench-agg-home-'), cacheRoot: toy.cacheRoot });
  if (!deliver) return;
  const repo = join(target, 'repos', 'toyshop');
  commitFiles(repo, AGENT_TESTS, 'test: stock reservation and orders (failing)');
  commitFiles(repo, TOY.referenceCode, 'feat: orders reserve stock');
}

/**
 * Lay out one kept harness sandbox and the eval JSON naming it, from the
 * captured fixture: `layout` places the workspace, `initCwd` overrides the
 * cwd the trace says the session ran in, `workerLines` are appended to the
 * worker transcript.
 */
async function harnessRun({ layout = 'sealed', initCwd = null, workerLines = [] as unknown[], deliver = true } = {}) {
  const root = makeTmpDir('bench-agg-');
  const sandbox = join(root, 'claude-eval-AbC123');
  const runtimeCwd = join(sandbox, 'home', 'cwd');
  const fill = (text: string) =>
    text
      .replaceAll('{{SANDBOX}}', fwd(sandbox))
      .replaceAll('{{PLUGIN_ROOT}}', fwd(REPO_ROOT))
      .replaceAll('{{HOME}}', fwd(root))
      .replaceAll('{{CAPABILITY}}', 'c'.repeat(64));
  if (layout === 'sealed' || layout === 'both') await workspaceAt(join(sandbox, 'sealed', 'home', 'cwd'), deliver);
  if (layout === 'runtime' || layout === 'both') await workspaceAt(runtimeCwd, deliver);
  const trace = fill(readFileSync(join(FIXTURE, 'trace.jsonl'), 'utf8'))
    .split('\n')
    .map((line) => {
      if (!line.includes('"subtype":"init"') || initCwd === null) return line;
      const event = JSON.parse(line);
      return JSON.stringify({ ...event, cwd: initCwd });
    })
    .join('\n');
  mkdirSync(join(sandbox, 'out'), { recursive: true });
  writeFileSync(join(sandbox, 'out', 'trace.jsonl'), trace);
  const slug = `-${fwd(runtimeCwd).replace(/^[A-Za-z]:/, '').split('/').filter(Boolean).join('-')}`;
  const session = join(sandbox, 'config', 'projects', slug, '00000000-0000-4000-8000-000000005e01');
  mkdirSync(join(session, 'subagents'), { recursive: true });
  writeFileSync(`${session}.jsonl`, trace);
  writeFileSync(join(session, 'subagents', 'agent-a0000000000000e01.jsonl'), fill(readFileSync(join(FIXTURE, 'worker.jsonl'), 'utf8')) + workerLines.map((l) => JSON.stringify(l)).join('\n'));
  const captured = JSON.parse(fill(readFileSync(join(FIXTURE, 'eval.json'), 'utf8')));
  const [c] = captured.cases;
  const run = { ...c.arms.with[0], tracePath: join(sandbox, 'out', 'trace.jsonl') };
  const evalJson = join(root, 'pilot.json');
  writeFileSync(evalJson, JSON.stringify({ ...captured, cases: [{ ...c, name: TOY_CASE.case, dir: `evals-public-projects/cases/${TOY_CASE.case}`, arms: { with: [run] } }] }, null, 2));
  return { sandbox, evalJson, workspace: join(sandbox, 'sealed', 'home', 'cwd') };
}

const aggregate = (evalJson: string) => verifyRunMain(['--aggregate', evalJson, '--suite-root', toy.suite, '--cache-root', toy.cacheRoot], { isolation: TEST_ISOLATION });
const readOf = (file: string) => ({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: file } }] } });
const bashOf = (command: string) => ({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_y', name: 'Bash', input: { command } }] } });

describe('verify-run --aggregate on a captured harness result', () => {
  it('verifies exactly the workspace the harness kept for the run, and finds no evaluator access in its transcripts', async () => {
    const { evalJson, workspace } = await harnessRun();
    const r = await aggregate(evalJson);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ case: TOY_CASE.case, arm: 'with', workspace });
    expect(r.runs[0].trace_access).toEqual({ hits: [], probes: [], transcripts: 3 });
    expect(r.runs[0].result.errors ?? []).toEqual([]);
    expect(r.runs[0].result.sections.acceptance.ok).toBe(true);
    // Harness runs ran their agents outside the boundary: never pilot evidence.
    expect(r).toMatchObject({ agent_isolation: { enforced: false, runner: 'claude plugin eval' }, trusted: false });
  }, 240_000);

  it('refuses a sandbox holding a decoy workspace, even one that would pass', async () => {
    // The honest workspace delivered nothing; a decoy beside it (found first by a breadth-first search) holds a good delivery.
    const { sandbox, evalJson } = await harnessRun({ deliver: false });
    await workspaceAt(join(sandbox, 'config', '.decoy'));
    const r = await aggregate(evalJson);
    expect(r.ok).toBe(false);
    expect(r.runs[0].result.ok).toBe(false);
    expect(r.runs[0].result.errors.join('\n')).toMatch(/decoy/);
  }, 240_000);

  it('refuses an ambiguous sandbox and a trace whose session ran elsewhere', async () => {
    const both = await harnessRun({ layout: 'both' });
    expect((await aggregate(both.evalJson)).runs[0].result.errors.join('\n')).toMatch(/ambiguous/);
    const elsewhere = await harnessRun({ initCwd: join(makeTmpDir('bench-agg-else-'), 'cwd') });
    expect((await aggregate(elsewhere.evalJson)).runs[0].result.errors.join('\n')).toMatch(/ran in/);
  }, 240_000);

  it('fails a run whose worker reached into the evaluator store, however the path was spelled', async () => {
    const hidden = join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD, 'hidden', 'mod-a', 'test', 'reserve.acceptance.test.mjs');
    const globbed = `cat ${fwd(toy.cacheRoot).slice(0, -2)}*/evaluator/*/${TOY_PRD}/hidden/*/test/*`;
    const { evalJson } = await harnessRun({ workerLines: [readOf(hidden), bashOf(globbed)] });
    const r = await aggregate(evalJson);
    expect(r.ok).toBe(false);
    expect(r.runs[0].ok).toBe(false);
    const hits = r.runs[0].trace_access.hits;
    expect(hits.map((h: any) => h.tool)).toEqual(['Read', 'Bash']);
    expect(hits.every((h: any) => h.file.includes('subagents'))).toBe(true);
  }, 240_000);

  it('rejects a harness result for a case outside the suite', async () => {
    const { evalJson } = await harnessRun();
    const data = JSON.parse(readFileSync(evalJson, 'utf8'));
    data.cases[0].name = 'not-a-case';
    writeFileSync(evalJson, JSON.stringify(data));
    const r = await aggregate(evalJson);
    expect(r.ok).toBe(false);
    expect(r.runs[0].result.errors.join('\n')).toMatch(/not part of this suite/);
  }, 240_000);
});

