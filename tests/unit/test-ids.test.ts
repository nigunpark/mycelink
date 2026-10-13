/**
 * Canonical test ids: what a worker names a criterion's test by.
 *
 * CSET-202 r2: settle refused the cli node's criterion evidence twice with
 * CRITERION_TEST_UNKNOWN because workers and the controller guessed how a
 * nested Vitest test is named (`describe > it` against the bare `it`), and
 * those guesses consumed both product attempts. A model cannot know the
 * verifier's canonical name, so every gate now publishes, for each test it
 * ran, an id: a stable hash of the report adapter, the normalised
 * repository-relative path and the framework's full name. Same test, same
 * id, on every run and platform; a different test (another file, another
 * describe, another adapter) never shares it.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalTestId, canonicalTests, fullNameOf, normalizeTestPath, TEST_ID_PATTERN } from '../../src/evidence/test-ids.js';
import { parseJUnit, parseVitestJson } from '../../src/evidence/red-classify.js';
import { SUREFIRE_VISITS, VITEST_R1 } from '../helpers/red-corpus.js';

describe('canonical test ids', () => {
  it('is 16 hex digits of a SHA-256 over the adapter, the normalised path and the full name', () => {
    const id = canonicalTestId('vitest-json', 'packages/errors/src/index.test.ts', 'ChangesetValidationError > is exported as a class');
    expect(id).toMatch(TEST_ID_PATTERN);
    expect(id).toBe(createHash('sha256').update(JSON.stringify(['vitest-json', 'packages/errors/src/index.test.ts', 'ChangesetValidationError > is exported as a class'])).digest('hex').slice(0, 16));
    // The same test however its path is spelled.
    expect(canonicalTestId('vitest-json', './packages\\errors\\src\\index.test.ts', 'ChangesetValidationError > is exported as a class')).toBe(id);
    expect(normalizeTestPath('./packages\\errors//src/index.test.ts')).toBe('packages/errors/src/index.test.ts');
    // Another adapter, file or name is another test.
    expect(canonicalTestId('junit-xml', 'packages/errors/src/index.test.ts', 'ChangesetValidationError > is exported as a class')).not.toBe(id);
    expect(canonicalTestId('vitest-json', 'packages/read/src/index.test.ts', 'ChangesetValidationError > is exported as a class')).not.toBe(id);
    expect(canonicalTestId('vitest-json', 'packages/errors/src/index.test.ts', 'is exported as a class')).not.toBe(id);
  });

  it("names a nested Vitest test by its describes and title, as the framework does, and the same leaf in two describes apart", () => {
    const results = parseVitestJson(VITEST_R1, { root: '/ws/tree' });
    const tests = canonicalTests(results, 'vitest-json');
    const sorts = tests.find((t) => t.full_name.endsWith('sorts issues and formats the message'))!;
    expect(sorts).toEqual({
      id: canonicalTestId('vitest-json', 'packages/errors/src/index.test.ts', 'Error classes > ChangesetValidationError > sorts issues and formats the message'),
      path: 'packages/errors/src/index.test.ts',
      full_name: 'Error classes > ChangesetValidationError > sorts issues and formats the message',
      name: 'sorts issues and formats the message',
      status: 'failed',
      category: 'missing-symbol',
    });
    // Ids are unique across the report.
    expect(new Set(tests.map((t) => t.id)).size).toBe(tests.length);
    // A suite that failed to load is one result of its file.
    expect(tests.find((t) => t.path === 'packages/cli/src/__tests__/validation-report.test.ts')).toMatchObject({ full_name: '<suite>', status: 'failed' });
  });

  it('names a Surefire test by its class and method, without the module directory', () => {
    const results = parseJUnit(SUREFIRE_VISITS, { root: '/ws/tree', moduleDir: 'spring-petclinic-visits-service' });
    expect(fullNameOf(results[0]!)).toBe('org.example.visits.web.VisitResourceTest#storesVetId');
    const [first] = canonicalTests(results, 'junit-xml');
    expect(first).toMatchObject({
      id: canonicalTestId('junit-xml', 'spring-petclinic-visits-service/src/test/java/org/example/visits/web/VisitResourceTest.java', 'org.example.visits.web.VisitResourceTest#storesVetId'),
      path: 'spring-petclinic-visits-service/src/test/java/org/example/visits/web/VisitResourceTest.java',
      status: 'failed',
    });
  });

  it("names a Node runner test by its describes and name, top-level tests by their name", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="top level passes" time="0.1" classname="test" file="/ws/tree/test/a.test.mjs"/>
\t<testsuite name="outer" tests="2">
\t\t<testcase name="leaf" time="0.1" classname="test" file="/ws/tree/test/a.test.mjs"/>
\t\t<testsuite name="inner" tests="1">
\t\t\t<testcase name="leaf" time="0.1" classname="test" file="/ws/tree/test/a.test.mjs"/>
\t\t</testsuite>
\t</testsuite>
</testsuites>`;
    const tests = canonicalTests(parseJUnit(xml, { root: '/ws/tree' }), 'junit-xml');
    expect(tests.map((t) => [t.path, t.full_name, t.name])).toEqual([
      ['test/a.test.mjs', 'top level passes', 'top level passes'],
      ['test/a.test.mjs', 'outer > leaf', 'leaf'],
      ['test/a.test.mjs', 'outer > inner > leaf', 'leaf'],
    ]);
    expect(new Set(tests.map((t) => t.id)).size).toBe(3);
  });
});
