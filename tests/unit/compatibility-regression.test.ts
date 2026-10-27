/**
 * The compatibility-regression unit: tests alone, after the production code,
 * proving behaviour that already exists.
 *
 * CSET-203 r3: the reviewer found AC-5 ("`changeset status` and `changeset
 * add` are unaffected by a journal") proved by the green suite alone — no
 * test puts a journal beside a changeset and runs status. The repair is a
 * test, not code: the behaviour already holds. But a test committed after
 * the production code was refused as `test-after` by settle and the replay
 * alike, and in a node whose production was already in its base there was
 * no RED to give it, so there was no legitimate way to close the gap.
 *
 * A history may now end with a compatibility-regression unit, mechanically
 * distinct from a RED cycle:
 *
 *  - test-only commits, after the node's production (or a node's whole
 *    history, when its production is already in its base), each carrying the
 *    trailer `Mycelink-Compatibility: <AC>` that binds it to compatibility
 *    criteria of the node (a new behaviour can never be proved so);
 *  - adding tests only: no test removed or edited (an assertion weakened), no
 *    test file deleted, no existing test data changed, nothing unreadable;
 *  - its tests then pass in the node's green gate at the head (settle binds
 *    them to the compatibility criterion's evidence).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { COMPATIBILITY_TRAILER, DEFAULT_TDD_POLICY, redBinding, verifyTddHistory, type RedBinding } from '../../src/engine/tdd-history.js';
import { declaredTests, priorTestChanges, testsInDelta } from '../../src/engine/test-declarations.js';

afterAll(() => cleanupTmpRoots());

const STATUS_TEST = 'packages/cli/test/status.test.mjs';
const VERSION_TEST = 'packages/cli/test/version.test.mjs';
const SRC = 'packages/cli/src/index.mjs';

const STATUS_BASE = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/index.mjs';

describe('status', () => {
  test('lists the pending changesets', () => {
    const lines = [];
    status({ files: new Map([['.changeset/a.md', 'a']]), io: { log: (l) => lines.push(l) } });
    assert.deepEqual(lines, ['.changeset/a.md']);
  });
});
`;

/** The compatibility test r3's reviewer asked for, appended inside the describe. */
const STATUS_WITH_JOURNAL = STATUS_BASE.replace(
  '  });\n});\n',
  `  });

  test('is unaffected by a journal left in .changeset', () => {
    const lines = [];
    status({ files: new Map([['.changeset/a.md', 'a'], ['.changeset/.version-journal.json', '{}']]), io: { log: (l) => lines.push(l) } });
    assert.deepEqual(lines, ['.changeset/a.md']);
  });
});
`,
);

function repo(): string {
  return makeGitRepo(makeTmpDir('compat-unit-'), {
    files: {
      [SRC]: 'export function status({ files, io }) { for (const p of files.keys()) if (/^\\.changeset\\/[^.][^/]*\\.md$/.test(p)) io.log(p); return 0; }\nexport function version() { return 0; }\n',
      [STATUS_TEST]: STATUS_BASE,
      [VERSION_TEST]: "import { test } from 'node:test';\ntest('versions', () => {});\n",
      'packages/cli/test/fixtures/plan.json': '{"releases":[]}\n',
    },
  });
}

const head = (r: string): string => git(r, ['rev-parse', 'HEAD']);
const commitWith = (r: string, message: string, trailer?: string): string => {
  git(r, ['add', '-A']);
  git(r, ['commit', '-q', '-m', message, ...(trailer !== undefined ? ['-m', trailer] : [])]);
  return head(r);
};

/** A complete RED cycle on the version command: its test alone (bound by a red gate), then production alone. */
function versionCycle(r: string): { binding: RedBinding; red: string; green: string } {
  writeFiles(r, { [VERSION_TEST]: "import { test } from 'node:test';\ntest('versions', () => {});\ntest('recovers an interrupted run', () => {});\n" });
  const { binding } = redBinding(r, DEFAULT_TDD_POLICY, 'e'.repeat(64));
  const red = commitAll(r, 'test(cli): AC-3 RED');
  writeFiles(r, { [SRC]: 'export function status({ files, io }) { for (const p of files.keys()) if (/^\\.changeset\\/[^.][^/]*\\.md$/.test(p)) io.log(p); return 0; }\nexport function version() { return 1; }\n' });
  const green = commitAll(r, 'fix(cli): AC-3');
  return { binding, red, green };
}

const verify = (r: string, base: string, bindings: RedBinding[], compatibility?: string[]) =>
  verifyTddHistory({ repoPath: r, base, head: head(r), policy: DEFAULT_TDD_POLICY, bindings, requireRed: true, ...(compatibility !== undefined ? { compatibility: { criteria: compatibility } } : {}) });

describe('a compatibility-regression unit after the production code', () => {
  it('is accepted, apart from the RED cycles, when its commits name a compatibility criterion of the node', () => {
    const r = repo();
    const base = head(r);
    const cycle = versionCycle(r);
    writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
    const compat = commitWith(r, 'test(cli): AC-5 status ignores a journal', `${COMPATIBILITY_TRAILER}: AC-5`);
    const h = verify(r, base, [cycle.binding], ['AC-5']);
    expect(h.violation).toBeNull();
    expect(h.ok).toBe(true);
    expect(h.cycles.map((c) => [c.red_commits, c.green_commits])).toEqual([[[cycle.red], [cycle.green]]]);
    expect(h.compatibility).toEqual([
      {
        kind: 'compatibility-regression',
        commits: [compat],
        criteria: ['AC-5'],
        declared: [{ file: STATUS_TEST, name: 'is unaffected by a journal left in .changeset' }],
        tests: [{ path: STATUS_TEST, blob: git(r, ['rev-parse', `${compat}:${STATUS_TEST}`]) }],
      },
    ]);
  });

  it('without the trailer it is a test after the production code, as before', () => {
    const r = repo();
    const base = head(r);
    const cycle = versionCycle(r);
    writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
    commitWith(r, 'test(cli): status ignores a journal');
    const h = verify(r, base, [cycle.binding], ['AC-5']);
    expect(h.violation?.code).toBe('TEST_AFTER');
    expect(h.violation?.detail).toContain(`${COMPATIBILITY_TRAILER}: <AC>`);
  });

  it('a new behaviour, or a criterion the node does not serve as compatibility, cannot be proved so', () => {
    for (const [trailer, criteria] of [['AC-3', ['AC-5']], ['AC-5, AC-3', ['AC-5']], ['AC-5', []], ['AC-5', undefined]] as [string, string[] | undefined][]) {
      const r = repo();
      const base = head(r);
      const cycle = versionCycle(r);
      writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
      commitWith(r, 'test(cli): status ignores a journal', `${COMPATIBILITY_TRAILER}: ${trailer}`);
      const h = verify(r, base, [cycle.binding], criteria);
      expect(h.violation?.code, `${trailer} / ${JSON.stringify(criteria)}`).toBe('COMPATIBILITY_CRITERION_INVALID');
    }
  });

  it('may only add tests: removing, editing (weakening), deleting a test file or changing existing test data is refused', () => {
    const cases: [string, (r: string) => void][] = [
      ['edits an assertion', (r) => writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL.replace("assert.deepEqual(lines, ['.changeset/a.md']);\n  });\n\n", 'assert.ok(lines);\n  });\n\n') })],
      ['removes a test', (r) => writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL.replace(/ {2}test\('lists the pending changesets'[\s\S]*?\n {2}\}\);\n\n/, '') })],
      ['changes test data', (r) => writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL, 'packages/cli/test/fixtures/plan.json': '{"releases":[1]}\n' })],
      ['deletes a test file', (r) => {
        writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
        git(r, ['rm', '-q', VERSION_TEST]);
      }],
    ];
    for (const [what, change] of cases) {
      const r = repo();
      const base = head(r);
      const cycle = versionCycle(r);
      change(r);
      commitWith(r, `test(cli): ${what}`, `${COMPATIBILITY_TRAILER}: AC-5`);
      const h = verify(r, base, [cycle.binding], ['AC-5']);
      expect(h.violation?.code, what).toBe('COMPATIBILITY_WEAKENS');
    }
  });

  it('a new test data file and a test appended after the last one are additions, not edits', () => {
    const r = repo();
    const base = head(r);
    const cycle = versionCycle(r);
    writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL, 'packages/cli/test/fixtures/journal.json': '{"before":[]}\n' });
    commitWith(r, 'test(cli): AC-5', `${COMPATIBILITY_TRAILER}: AC-5`);
    expect(verify(r, base, [cycle.binding], ['AC-5'])).toMatchObject({ ok: true, violation: null });
  });

  it("a reworked node whose production is in its base: its whole history may be the unit, no fake production commit", () => {
    const r = repo();
    const base = head(r);
    writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
    const compat = commitWith(r, 'test(cli): AC-5 status ignores a journal', `${COMPATIBILITY_TRAILER}: AC-5`);
    const h = verify(r, base, [], ['AC-5']);
    expect(h.violation).toBeNull();
    expect(h.cycles).toEqual([]);
    expect(h.compatibility.map((u) => [u.commits, u.criteria])).toEqual([[[compat], ['AC-5']]]);
    // Without the trailer it is a RED no red gate ran.
    const plain = repo();
    const plainBase = head(plain);
    writeFiles(plain, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
    commitWith(plain, 'test(cli): status ignores a journal');
    expect(verify(plain, plainBase, [], ['AC-5']).violation?.code).toBe('RED_NOT_BOUND');
  });

  it('a test-only commit followed by production is a RED cycle, whatever its trailer says', () => {
    const r = repo();
    const base = head(r);
    const cycle = versionCycle(r);
    writeFiles(r, { [STATUS_TEST]: STATUS_WITH_JOURNAL });
    commitWith(r, 'test(cli): AC-5', `${COMPATIBILITY_TRAILER}: AC-5`);
    writeFiles(r, { [SRC]: 'export function status() { return 2; }\nexport function version() { return 1; }\n' });
    commitAll(r, 'fix(cli): status');
    // The status test's RED was never bound by a red gate.
    expect(verify(r, base, [cycle.binding], ['AC-5']).violation?.code).toBe('RED_NOT_BOUND');
  });
});

describe('priorTestChanges: what a unit did to the tests that were there', () => {
  it('bounds nested JS delimiters and template interpolation without swallowing a sibling suite', () => {
    const block = 'test("nested", () => { const t = `text ) ${fn({value: `nested ${"}"}`})}`; expect(fn([1, (2)])).toBeDefined(); });';
    expect(declaredTests('nested.test.ts', `${block}\ndescribe("next", () => {});`)).toEqual([
      { name: 'nested', block },
    ]);
  });

  it('fails closed on changed JS calls with ambiguous slash delimiters', () => {
    const path = 'opaque.test.ts';
    const before = "test('opaque', () => { expect(/[(]/.test('(')).toBe(true); });";
    const after = before.replace('true', 'false');
    expect(priorTestChanges([{ path, before, after }]).edited).toEqual([{ file: path, name: 'opaque' }]);
  });

  describe.each(['js', 'ts'])('JS/TS sibling suite boundary (.%s)', (extension) => {
    const path = `packages/planner/test/index.test.${extension}`;
    const previous = `it.only('aggregates unknown packages', async () => {
  const input = { packages: [{ name: 'unknown', metadata: { enabled: true } }] };
  const punctuation = '}); describe("not a suite", () => {';
  const message = \`unknown: \${input.packages[0].name}\`;
  // }); test('not a test', () => {});
  /* unmatched punctuation in a comment: } ) ] */
  expect({ input, punctuation, message }).toBeDefined();
  expect(input.packages).toHaveLength(1);
});`;
    const sibling = `describe("link: protocol", () => {
  test.skip('keeps linked packages', () => {
    expect('link:local').toContain('link:');
  });
});
`;
    const added = `test('reports another unknown package', () => {
  expect(['another']).toEqual(['another']);
});

`;
    const before = `${previous}\n\n${sibling}`;
    // A pure insertion between the existing test's }); and the sibling describe.
    const after = `${previous}\n\n${added}${sibling}`;

    it('inserting a test immediately before a sibling describe preserves prior bodies and identities', () => {
      const delta = [{ path, before, after }];
      expect(priorTestChanges(delta)).toEqual({ removed: [], edited: [], deleted: [], data: [], opaque: [] });
      expect(declaredTests(path, after).map((test) => test.name)).toEqual([
        'aggregates unknown packages', 'reports another unknown package', 'keeps linked packages',
      ]);
      expect(declaredTests(path, after)[0]?.block).toBe(declaredTests(path, before)[0]?.block);
      expect(testsInDelta(delta)).toEqual({
        declared: [{ file: path, name: 'reports another unknown package' }], removed: [], opaque: [],
      });
    });

    it('still detects an assertion edit in the previous test beside the insertion', () => {
      const changed = after.replace('toHaveLength(1)', 'toHaveLength(10)');
      expect(priorTestChanges([{ path, before, after: changed }])).toEqual({
        removed: [], edited: [{ file: path, name: 'aggregates unknown packages' }], deleted: [], data: [], opaque: [],
      });
    });

    it.each(['}', ')'])('fails closed when the previous test loses its closing %s', (closer) => {
      // Keep the assertion text intact: dropping only closers must not count as preservation.
      const malformed = previous.slice(0, -3) + (closer === '}' ? ');' : '};');
      expect(priorTestChanges([{ path, before: `${previous}\n`, after: `${malformed}\n` }])).toEqual({
        removed: [], edited: [{ file: path, name: 'aggregates unknown packages' }], deleted: [], data: [], opaque: [],
      });
    });
  });

  it('a test appended inside a describe moves the closers of the one before it: no edit', () => {
    expect(priorTestChanges([{ path: STATUS_TEST, before: STATUS_BASE, after: STATUS_WITH_JOURNAL }])).toEqual({ removed: [], edited: [], deleted: [], data: [], opaque: [] });
  });

  it('a changed expectation, even one character on, is an edit; a removed test is a removal', () => {
    const changed = STATUS_BASE.replace("['.changeset/a.md']);\n  });", "['.changeset/a.mdx']);\n  });");
    expect(priorTestChanges([{ path: STATUS_TEST, before: STATUS_BASE, after: changed }]).edited).toEqual([{ file: STATUS_TEST, name: 'lists the pending changesets' }]);
    expect(priorTestChanges([{ path: STATUS_TEST, before: STATUS_BASE, after: "describe('status', () => {});\n" }]).removed).toEqual([{ file: STATUS_TEST, name: 'lists the pending changesets' }]);
  });

  it('a deleted test file, a changed data file and unreadable test code are reported; a new data file is not', () => {
    expect(
      priorTestChanges([
        { path: VERSION_TEST, before: "test('versions', () => {});\n", after: null },
        { path: 'packages/cli/test/fixtures/plan.json', before: '{}\n', after: '{"a":1}\n' },
        { path: 'packages/cli/test/fixtures/new.json', before: null, after: '{}\n' },
        { path: 'spec/status_spec.rb', before: "it 'a' do\nend\n", after: "it 'b' do\nend\n" },
      ]),
    ).toEqual({ removed: [{ file: VERSION_TEST, name: 'versions' }], edited: [], deleted: [VERSION_TEST], data: ['packages/cli/test/fixtures/plan.json'], opaque: ['spec/status_spec.rb'] });
  });
});

describe('a compatibility-regression unit never changes a test file a RED of the history bound', () => {
  const VERSION_RED = "import { test } from 'node:test';\ntest('versions', () => {});\ntest('recovers an interrupted run', () => {});\n";

  it("AC-5's test appended after the code to the file AC-3's RED bound (CSET-203 r4): CHANGED_RED_BLOBS, the file named", () => {
    const r = repo();
    const base = head(r);
    const cycle = versionCycle(r);
    writeFiles(r, { [VERSION_TEST]: `${VERSION_RED}test('status is unaffected by a journal', () => {});\n` });
    const compat = commitWith(r, 'test(cli): AC-5 beside the RED test', `${COMPATIBILITY_TRAILER}: AC-5`);
    const h = verify(r, base, [cycle.binding], ['AC-5']);
    expect(h.ok).toBe(false);
    expect(h.violation).toMatchObject({ code: 'CHANGED_RED_BLOBS', commit: compat, paths: [VERSION_TEST] });
    expect(h.violation?.detail).toMatch(/RED-bound/);
    expect(h.violation?.detail).toMatch(/new test file/);
  });

  it('the same test in a file no RED bound is the unit, accepted', () => {
    const r = repo();
    const base = head(r);
    const cycle = versionCycle(r);
    writeFiles(r, { 'packages/cli/test/journal-compat.test.mjs': "import { test } from 'node:test';\ntest('status is unaffected by a journal', () => {});\n" });
    commitWith(r, 'test(cli): AC-5 in a file of its own', `${COMPATIBILITY_TRAILER}: AC-5`);
    expect(verify(r, base, [cycle.binding], ['AC-5'])).toMatchObject({ ok: true, violation: null });
  });

  it("a later cycle's RED may change the file again (its own gate binds it); a unit after that cycle still may not", () => {
    const r = repo();
    const base = head(r);
    const first = versionCycle(r);
    writeFiles(r, { [VERSION_TEST]: `${VERSION_RED}test('reports a failed apply', () => {});\n` });
    const { binding: second } = redBinding(r, DEFAULT_TDD_POLICY, 'f'.repeat(64));
    commitAll(r, 'test(cli): AC-4 RED');
    writeFiles(r, { [SRC]: 'export function status({ files, io }) { return 0; }\nexport function version() { return 2; }\n' });
    commitAll(r, 'fix(cli): AC-4');
    expect(verify(r, base, [first.binding, second], ['AC-5'])).toMatchObject({ ok: true, violation: null });
    writeFiles(r, { [VERSION_TEST]: `${VERSION_RED}test('reports a failed apply', () => {});\ntest('status is unaffected by a journal', () => {});\n` });
    commitWith(r, 'test(cli): AC-5', `${COMPATIBILITY_TRAILER}: AC-5`);
    expect(verify(r, base, [first.binding, second], ['AC-5']).violation).toMatchObject({ code: 'CHANGED_RED_BLOBS', paths: [VERSION_TEST] });
  });
});
