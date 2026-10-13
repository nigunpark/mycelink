/**
 * Generated `claude plugin eval` cases: deterministic, committed without
 * drift, one prompt per PRD that both orchestration arms receive byte for
 * byte (the only arm difference is whether the plugin is installed), and
 * nothing in them but the public requirement's location and lightweight
 * structural graders — no hidden test, reference, mutant, lock or hash.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { MYCELINK_INSTRUCTION, caseDrift, casePrompt, generateCases, writeCases } from '../../evals-public-projects/lib/cases.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadSuite } from '../../evals-public-projects/lib/manifests.mjs';

afterAll(() => cleanupTmpRoots());

const SUITE = join(REPO_ROOT, 'evals-public-projects');
const suite = loadSuite(SUITE);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const generated: Map<string, string> = generateCases(suite);

describe('generateCases', () => {
  it('produces a case.yaml and a scaffold.sh for each of the six PRDs', () => {
    expect([...generated.keys()].sort()).toEqual(
      suite.projects.flatMap((p: any) => p.prds.map((prd: any) => [`${prd.manifest.case}/case.yaml`, `${prd.manifest.case}/scaffold.sh`])).flat().sort(),
    );
    expect(generated.size).toBe(12);
  });

  it('is deterministic and the committed cases have no drift', () => {
    expect(generateCases(loadSuite(SUITE))).toEqual(generated);
    for (const [rel, body] of generated) expect(readFileSync(join(SUITE, 'cases', ...rel.split('/')), 'utf8'), rel).toBe(body);
    const committed = readdirSync(join(SUITE, 'cases')).filter((d) => !d.includes('.'));
    expect(committed.sort()).toEqual([...new Set([...generated.keys()].map((k) => k.split('/')[0]))].sort());
  });

  it('gives each case one prompt carrying the Mycelink availability-conditional instruction exactly once', () => {
    for (const project of suite.projects) {
      for (const prd of project.prds) {
        const prompt: string = casePrompt({ project, prd });
        expect(prompt.split(MYCELINK_INSTRUCTION).length, prd.manifest.id).toBe(2);
        expect(generated.get(`${prd.manifest.case}/case.yaml`)).toContain(prompt.split('\n')[0]);
        expect(prompt).toContain(`platform/requirements/${prd.manifest.id}.md`);
      }
    }
  });

  it('hands the harness exactly the prompt bytes run-arm sends (same SHA-256)', () => {
    for (const project of suite.projects) {
      for (const prd of project.prds) {
        const prompt: string = casePrompt({ project, prd });
        const parsed = YAML.parse(generated.get(`${prd.manifest.case}/case.yaml`)!);
        expect(parsed.execution.prompt, prd.manifest.id).toBe(prompt);
        expect(sha256(parsed.execution.prompt)).toBe(sha256(prompt));
      }
    }
  });

  it('prompts differ between PRDs only in project and requirement facts', () => {
    const shape = (prompt: string, project: any, prd: any) =>
      prompt.replaceAll(project.adapter.name, '<P>').replaceAll(prd.manifest.id, '<ID>').replaceAll(project.adapter.workspace.repo_dir, '<REPO>').replaceAll(project.adapter.workspace.branch, '<BRANCH>');
    const shapes = new Set(suite.projects.flatMap((p: any) => p.prds.map((prd: any) => shape(casePrompt({ project: p, prd }), p, prd))));
    expect(shapes.size).toBe(1);
  });

  it('carries no evaluator content, lock, hash or frozen commit, and only EVAL_ environment keys', () => {
    const forbidden = [/hidden/i, /reference/i, /mutant/i, /evaluator/i, /expected\.json/, /fingerprint/i, /\b[0-9a-f]{40}\b/, /\b[0-9a-f]{64}\b/, /\.bundle\b/, /mycelink-benchmark-cache/];
    for (const [rel, body] of generated) {
      // The did-not-read-evaluator grader is the one place that names the evaluator, as a pattern to refuse.
      const text = rel.endsWith('case.yaml') ? body.replace(/  - name: did-not-read-evaluator[\s\S]*?(?=\n  - name: )/, '') : body;
      for (const re of forbidden) expect(re.test(text), `${rel} matches ${re}`).toBe(false);
      const env = /\n  env:\n((?: {4}.+\n)+)/.exec(body)?.[1] ?? '';
      for (const line of env.split('\n').filter(Boolean)) expect(line.trim()).toMatch(/^EVAL_/);
    }
  });

  it('uses only lightweight structural graders', () => {
    for (const [rel, body] of generated) {
      if (!rel.endsWith('case.yaml')) continue;
      const types = [...body.matchAll(/^    type: (\S+)$/gm)].map((m) => m[1]);
      expect(new Set(types)).toEqual(new Set(['regex', 'tool_used', 'llm', 'file_exists']));
      expect(body).toMatch(/name: did-not-read-evaluator\n    type: regex\n    target: trace/);
    }
  });

  it('never deletes, nor counts as drift, the results the eval harness writes beside the cases; stale generated cases are reported, not deleted', () => {
    const dir = makeTmpDir('bench-cases-');
    writeCases(suite, dir);
    // `claude plugin eval --eval-dir <dir>` writes its results to <dir>/results/.
    mkdirSync(join(dir, 'results', 'run-1'), { recursive: true });
    writeFileSync(join(dir, 'results', 'run-1', 'report.json'), '{}\n');
    // A case directory the manifests no longer generate.
    mkdirSync(join(dir, 'retired-case'), { recursive: true });
    writeFileSync(join(dir, 'retired-case', 'case.yaml'), '# Generated by evals-public-projects/tools/generate-cases.mjs from\n');
    expect(caseDrift(suite, dir)).toEqual(['retired-case: not generated by the current manifests']);
    writeCases(suite, dir);
    expect(readFileSync(join(dir, 'results', 'run-1', 'report.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(dir, 'retired-case', 'case.yaml'))).toBe(true);
  });

  it('scaffolds through the suite tool with the case name, from the case directory', () => {
    for (const [rel, body] of generated) {
      if (!rel.endsWith('scaffold.sh')) continue;
      const name = rel.split('/')[0]!;
      expect(body.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(body).toContain(`exec node "$here/../../tools/scaffold.mjs" ${name} .`);
      expect(existsSync(join(SUITE, 'tools', 'scaffold.mjs'))).toBe(true);
    }
  });
});
