/**
 * The benchmark's committed contracts: JSON schemas, the strict validator
 * that enforces them at runtime, and the semantic rules a suite must meet
 * (three PRD archetypes per public project, each genuinely multi-module,
 * frozen source identities that recompute).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { loadSchema, validate } from '../../evals-public-projects/lib/schema.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { testedModules } from '../../evals-public-projects/lib/scope.mjs';

afterAll(() => cleanupTmpRoots());

const SUITE = join(REPO_ROOT, 'evals-public-projects');
const SCHEMAS = readdirSync(join(SUITE, 'schemas')).filter((f) => f.endsWith('.schema.json'));
const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

describe('strict schema validator', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'tags'],
    properties: {
      id: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 5 },
      tags: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['a', 'b', 'c'] } },
      n: { type: 'integer', minimum: 1, maximum: 3 },
      kind: { const: 'x' },
      ref: { $ref: '#/$defs/sha' },
      map: { type: 'object', additionalProperties: { type: 'string' } },
    },
    $defs: { sha: { type: 'string', pattern: '^[0-9a-f]{4}$' } },
  };

  it('accepts a conforming document', () => {
    expect(validate(schema, { id: 'ab', tags: ['a'], n: 2, kind: 'x', ref: 'beef', map: { k: 'v' } })).toEqual([]);
  });

  it('reports each violation with its JSON path', () => {
    const problems: string[] = validate(schema, { id: 'A1', tags: ['a', 'a', 'z'], n: 4.5, kind: 'y', ref: 'xyz', map: { k: 1 }, extra: true });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\$\.id: does not match/),
        expect.stringMatching(/^\$\.tags: more than 2 items/),
        expect.stringMatching(/^\$\.tags: items are not unique/),
        expect.stringMatching(/^\$\.tags\[2\]: not one of/),
        expect.stringMatching(/^\$\.n: expected integer/),
        expect.stringMatching(/^\$\.kind: must equal/),
        expect.stringMatching(/^\$\.ref: does not match/),
        expect.stringMatching(/^\$\.map\.k: expected string/),
        expect.stringMatching(/^\$: unexpected property extra/),
      ]),
    );
    expect(validate(schema, { tags: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/^\$: missing required property id/), expect.stringMatching(/^\$\.tags: fewer than 1 items/)]));
  });

  it('fails closed on a keyword it does not implement instead of ignoring the constraint', () => {
    expect(() => validate({ type: 'string', format: 'email' }, 'x')).toThrow(/unsupported schema keyword format/);
    expect(() => validate({ $ref: 'https://elsewhere/schema.json' }, 'x')).toThrow(/only local/);
  });
});

describe('committed schemas', () => {
  it.each(SCHEMAS)('%s is a valid draft 2020-12 schema that the runtime validator understands', (file) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const s = readJson(join(SUITE, 'schemas', file));
    expect(() => ajv.compile(s)).not.toThrow();
    expect(() => validate(s, {})).not.toThrow();
    expect(loadSchema(file.replace('.schema.json', ''))).toEqual(s);
  });

  it('the runtime validator agrees with ajv on every manifest and on broken copies of them', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const docs: Array<[string, unknown]> = [];
    for (const project of ['spring-petclinic-microservices', 'changesets']) {
      docs.push(['source-lock', readJson(join(SUITE, 'projects', project, 'source.lock.json'))]);
      docs.push(['project-adapter', readJson(join(SUITE, 'projects', project, 'adapter.json'))]);
      for (const prd of readdirSync(join(SUITE, 'projects', project, 'prds'))) {
        docs.push(['prd-case', readJson(join(SUITE, 'projects', project, 'prds', prd, 'case.json'))]);
      }
    }
    const broken = (d: any): any[] => [
      { ...d, schema: 'mycelink-bench/other@9' },
      { ...d, unexpected: 1 },
      Object.fromEntries(Object.entries(d).slice(1)),
    ];
    const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
    for (const [name, doc] of docs) {
      if (!compiled.has(name)) compiled.set(name, ajv.compile(loadSchema(name)));
      const check = compiled.get(name)!;
      expect(check(doc), `${name}: ${JSON.stringify(check.errors)}`).toBe(true);
      expect(validate(loadSchema(name), doc)).toEqual([]);
      for (const bad of broken(doc)) {
        expect(check(bad)).toBe(false);
        expect(validate(loadSchema(name), bad).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('committed qualification evidence', () => {
  it('every PRD is qualified, and its summary names no test or mutant and matches its evaluator lock', () => {
    for (const project of ['spring-petclinic-microservices', 'changesets']) {
      for (const prd of readdirSync(join(SUITE, 'projects', project, 'prds'))) {
        const dir = join(SUITE, 'projects', project, 'prds', prd);
        const summary = readJson(join(dir, 'qualification.json'));
        const lock = readJson(join(dir, 'evaluator.lock.json'));
        expect(validate(loadSchema('qualification'), summary), `${prd}`).toEqual([]);
        expect(validate(loadSchema('evaluator-lock'), lock), `${prd}`).toEqual([]);
        expect(summary.evaluator_digest_sha256).toBe(lock.digest_sha256);
        expect(summary.source_identity_sha256).toBe(readJson(join(SUITE, 'projects', project, 'source.lock.json')).identity_sha256);
        // Bound to the cache and toolchains it ran with, and to the trusted commands.
        expect(summary.bindings.cache_lock_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.keys(summary.bindings.toolchains)).toEqual([project === 'changesets' ? 'node' : 'java']);
        // At least one tmp root on another file system was really used.
        expect(summary.tmp_roots).toBeGreaterThanOrEqual(1);
        expect(summary.filesystems.distinct).toBe(summary.tmp_roots + 1);
        // Every required module with runtime behaviour has a gating mutant the hidden tests kill.
        const adapter = readJson(join(SUITE, 'projects', project, 'adapter.json'));
        const manifest = readJson(join(dir, 'case.json'));
        for (const m of manifest.modules.required.filter((id: string) => adapter.modules.find((x: any) => x.id === id).runtime_tests !== false)) {
          expect(summary.mutants.by_module?.[m] ?? 0, `${prd} ${m}`).toBeGreaterThan(0);
        }
        expect(summary.hidden_tests.total).toBe(lock.hidden_tests);
        expect(summary.mutants.killed).toBe(summary.mutants.gating);
        expect(lock.files.expected).toBe(1);
        expect(lock.files.hidden).toBeGreaterThan(0);
        expect(lock.files.mutant).toBe(lock.mutants);
        // Nothing committed names a hidden test file or a mutant.
        expect(JSON.stringify(lock) + JSON.stringify(summary)).not.toMatch(/\.java|\.ts\b|\.patch|hidden\//);
      }
    }
  });
});

describe('suite semantics', () => {
  it('the committed suite has the two public projects, three archetypes each, every PRD spanning at least two modules', () => {
    const suite = loadSuite(SUITE);
    expect(suite.problems).toEqual([]);
    expect(suite.projects.map((p: any) => p.adapter.id).sort()).toEqual(['changesets', 'spring-petclinic-microservices']);
    for (const project of suite.projects) {
      expect(project.prds.map((p: any) => p.manifest.archetype).sort()).toEqual([
        'additive-vertical-slice',
        'backward-compatible-behavioral-change',
        'failure-concurrency-recovery',
      ]);
      for (const prd of project.prds) expect(prd.manifest.modules.required.length).toBeGreaterThanOrEqual(2);
    }
  });

  function brokenSuite(edit: (root: string) => void): string[] {
    const root = join(makeTmpDir('bench-suite-'), 'suite');
    cpSync(join(SUITE, 'schemas'), join(root, 'schemas'), { recursive: true });
    cpSync(join(SUITE, 'projects'), join(root, 'projects'), { recursive: true });
    edit(root);
    return loadSuite(root).problems;
  }
  const editJson = (path: string, change: (d: any) => void) => {
    const d = readJson(path);
    change(d);
    writeFileSync(path, JSON.stringify(d, null, 2));
  };
  const prdCase = (root: string, project: string, prd: string) => join(root, 'projects', project, 'prds', prd, 'case.json');

  it('rejects a PRD that touches a single module', () => {
    const problems = brokenSuite((root) => editJson(prdCase(root, 'changesets', 'CSET-203'), (d) => (d.modules.required = ['cli'])));
    expect(problems.join('\n')).toMatch(/CSET-203.*(fewer than 2 items|at least two modules)/);
  });

  it('rejects a project whose PRDs do not cover each archetype exactly once', () => {
    const problems = brokenSuite((root) => editJson(prdCase(root, 'changesets', 'CSET-202'), (d) => (d.archetype = 'additive-vertical-slice')));
    expect(problems.join('\n')).toMatch(/changesets: archetypes/);
  });

  it('rejects modules the adapter does not define and criteria owned outside the allowed modules', () => {
    const problems = brokenSuite((root) =>
      editJson(prdCase(root, 'spring-petclinic-microservices', 'PCM-102'), (d) => {
        d.modules.allowed.push('billing-service');
        d.acceptance_criteria[0].modules = ['vets-service'];
      }),
    );
    expect(problems.join('\n')).toMatch(/PCM-102: unknown module billing-service/);
    expect(problems.join('\n')).toMatch(/PCM-102: AC-1 is owned by vets-service, which is not an allowed module/);
  });

  it('rejects a required module the requirement document never names', () => {
    const problems = brokenSuite((root) => {
      const file = join(root, 'projects', 'changesets', 'prds', 'CSET-201', 'requirement.md');
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('packages/types', 'the types package'));
    });
    expect(problems.join('\n')).toMatch(/CSET-201: requirement\.md never names module types \(packages\/types\)/);
  });

  it('rejects a source lock whose identity does not recompute or whose history is inconsistent', () => {
    const problems = brokenSuite((root) => {
      editJson(join(root, 'projects', 'changesets', 'source.lock.json'), (d) => (d.tree = 'f'.repeat(40)));
      editJson(join(root, 'projects', 'spring-petclinic-microservices', 'source.lock.json'), (d) => (d.history.shallow_boundary = []));
    });
    expect(problems.join('\n')).toMatch(/changesets: identity_sha256 does not match/);
    expect(problems.join('\n')).toMatch(/spring-petclinic-microservices: a shallow history needs its boundary commits/);
  });

  it('rejects a budget beyond what the claude plugin eval loader accepts (200 turns, 3600 s)', () => {
    const turns = brokenSuite((root) => editJson(prdCase(root, 'changesets', 'CSET-201'), (d) => (d.budget.max_turns = 201)));
    expect(turns.join('\n')).toMatch(/CSET-201.*max_turns: greater than 200/);
    const seconds = brokenSuite((root) => editJson(prdCase(root, 'changesets', 'CSET-201'), (d) => (d.budget.timeout_seconds = 3601)));
    expect(seconds.join('\n')).toMatch(/CSET-201.*timeout_seconds: greater than 3600/);
  });

  it('marks a declarations-only module, which needs production changes but cannot gain runtime tests, and still requires a tested module per PRD', () => {
    const suite = loadSuite(SUITE);
    const changesets = suite.projects.find((p: any) => p.id === 'changesets');
    // packages/types holds only TypeScript declarations (src/index.ts) at the frozen commit, and
    // site/ is the documentation website, with no runtime tests upstream.
    expect(changesets.adapter.modules.filter((m: any) => m.runtime_tests === false).map((m: any) => m.id)).toEqual(['types', 'site']);
    const cset201 = changesets.prds.find((p: any) => p.manifest.id === 'CSET-201');
    expect(testedModules(changesets.adapter, cset201.manifest.modules.required)).toEqual(['assemble-release-plan', 'cli']);
    const problems = brokenSuite((root) => {
      editJson(join(root, 'projects', 'changesets', 'adapter.json'), (d) => {
        for (const m of d.modules) if (m.id === 'assemble-release-plan' || m.id === 'cli') m.runtime_tests = false;
      });
    });
    expect(problems.join('\n')).toMatch(/CSET-201: every required module is declarations only/);
  });

  it('rejects duplicate case names across projects', () => {
    const problems = brokenSuite((root) => editJson(prdCase(root, 'changesets', 'CSET-201'), (d) => (d.case = 'petclinic-visit-vet-assignment')));
    expect(problems.join('\n')).toMatch(/duplicate case name petclinic-visit-vet-assignment/);
  });
});
