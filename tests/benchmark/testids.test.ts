/**
 * Which tests a delta declares: the TDD replay derives its expected test
 * ids from the test files a test-first delta adds or changes, never from
 * running them.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { declaredTests, testsInDelta } from '../../evals-public-projects/lib/testids.mjs';

const JS = `import { describe, it, test } from 'vitest';
describe('status', () => {
  it('prints a reason per package', async () => {
    expect(1).toBe(1);
  });
  test.skip("skips nothing", () => {});
  it.todo('later');
  it(\`uses a template\`, () => {});
  it(\`interpolates \${name}\`, () => {});
});
test('top level', () => {
  const nested = "it('not a test', () => {})";
});
`;

const JAVA = `package org.example.visits.web;

class VisitResourceTest {
    @Test
    void shouldFetchVisits() throws Exception {
        mvc.perform(get("/pets/visits"));
    }

    @ParameterizedTest
    @ValueSource(ints = {0, -1})
    public void rejectsNonPositiveVetId(int vetId) {
    }

    @RepeatedTest(3)
    void concurrent() {}

    private Visit helper() { return null; }
}
`;

describe('declaredTests', () => {
  it('finds JS/TS test declarations with their names, ignoring strings and interpolated names', () => {
    expect(declaredTests('a.test.ts', JS).map((t: any) => t.name)).toEqual(['prints a reason per package', 'skips nothing', 'later', 'uses a template', 'top level']);
  });

  it('finds JUnit test methods (Test, ParameterizedTest, RepeatedTest), not helpers', () => {
    expect(declaredTests('VisitResourceTest.java', JAVA).map((t: any) => t.name)).toEqual(['shouldFetchVisits', 'rejectsNonPositiveVetId', 'concurrent']);
  });
});

describe('testsInDelta', () => {
  const isTestPath = (p: string) => p.includes('/test/') || p.endsWith('.test.ts');
  it('returns tests added or changed by the delta, in order, and nothing for removed tests or non-test files', () => {
    const before = "it('a', () => { x(1); });\nit('b', () => { x(2); });\nit('c', () => { x(3); });\n";
    const after = "it('b', () => { x(20); });\nit('c', () => { x(3); });\nit('d', () => { x(4); });\n";
    const delta = [
      { path: 'pkg/a.test.ts', before, after },
      { path: 'pkg/new.test.ts', before: null, after: "it('fresh', () => {});\n" },
      { path: 'pkg/gone.test.ts', before: "it('old', () => {});\n", after: null },
      { path: 'pkg/src/a.ts', before: '', after: "it('not a test file', () => {});\n" },
    ];
    expect(testsInDelta(delta, { isTestPath })).toEqual([
      { file: 'pkg/a.test.ts', name: 'b' },
      { file: 'pkg/a.test.ts', name: 'd' },
      { file: 'pkg/new.test.ts', name: 'fresh' },
    ]);
  });

  it('works for Java test sources', () => {
    const after = JAVA.replace('mvc.perform(get("/pets/visits"));', 'mvc.perform(get("/pets/visits?petId=1"));');
    expect(testsInDelta([{ path: 'svc/src/test/java/org/example/visits/web/VisitResourceTest.java', before: JAVA, after }], { isTestPath })).toEqual([
      { file: 'svc/src/test/java/org/example/visits/web/VisitResourceTest.java', name: 'shouldFetchVisits' },
    ]);
  });
});
