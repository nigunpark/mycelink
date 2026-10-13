/**
 * Which test file a Node JUnit result is from, when the report does not say.
 *
 * Node's JUnit reporter names each test's file (`file="..."`) from Node 24.11
 * on; Node 22's names none, so on Node 22 every RED read its declared tests as
 * not run (CI 38347201692). A test is given a file only where its sources
 * leave no other:
 *
 *  - a test file that failed before any test registered is reported under
 *    its own path, as the command named it: that file, when it is a test file
 *    of the scope and no test is titled so;
 *  - any other test, the one test file of the scope that declares it — its
 *    title as a static test name, or a template-titled test whose template
 *    carries it — with every suite of its chain as a static suite name
 *    (engine/test-declarations.ts); a static title only as often as that file
 *    declares it; never when another file could have run it, and never when
 *    its failure's stack names another test file of the scope.
 *
 * Anything else names no file: it matches no declared test, so a RED that
 * declares it did not run (fail closed). The scope is read once, bounded,
 * without following links.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredJsSuites, declaredTestTemplates, declaredTests, templateMatches, testLanguage } from '../engine/test-declarations.js';
import { repoRelative, type FilelessTest, type JUnitFileAttribution } from './red-classify.js';
import { readRegular } from '../security/paths.js';

/** Entries looked at, and bytes of test sources read, at most; past either nothing is attributed. */
export const MAX_SCOPE_ENTRIES = 50_000;
export const MAX_SCOPE_BYTES = 64 * 1024 * 1024;
/** A source larger than this is no test file the scope reads. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

interface TestFile {
  rel: string;
  /** Each static test title, with how often the file declares it. */
  titles: Map<string, number>;
  suites: Set<string>;
  templates: string[];
}

/** The JS test files under `scope` (no node_modules, no dot directories, no links), or null when the scope is too large to read. */
function testFiles(root: string, scope: string): TestFile[] | null {
  const out: TestFile[] = [];
  const pending = [scope];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (++entries > MAX_SCOPE_ENTRIES) return null;
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!st.isFile() || st.size > MAX_SOURCE_BYTES) continue;
      const rel = relative(root, full).split('\\').join('/');
      if (testLanguage(rel) !== 'js') continue;
      bytes += st.size;
      if (bytes > MAX_SCOPE_BYTES) return null;
      // Through one descriptor, never through a link: what was looked at is what is read.
      const read = readRegular(full, MAX_SOURCE_BYTES);
      if (read === null) continue;
      const source = read.bytes.toString('utf8');
      const titles = new Map<string, number>();
      for (const t of declaredTests(rel, source)) titles.set(t.name, (titles.get(t.name) ?? 0) + 1);
      const templates = declaredTestTemplates(rel, source).map((t) => t.template);
      if (titles.size === 0 && templates.length === 0) continue;
      out.push({ rel, titles, suites: new Set(declaredJsSuites(source)), templates });
    }
  }
  return out;
}

const SOURCE_EXT = '(?:mjs|cjs|js|jsx|ts|mts|cts|tsx)';
const FILE_URL = /file:\/\/[^\s)'"<>]+/g;
const POSIX_PATH = new RegExp(`(?<=[\\s(]|^)/[^\\s:()'"<>]+\\.${SOURCE_EXT}(?=[:)\\s]|$)`, 'gm');
const WINDOWS_PATH = new RegExp(`[A-Za-z]:\\\\[^\\s:()'"<>]+\\.${SOURCE_EXT}(?=[:)\\s]|$)`, 'gm');

/** The test files of the scope a failure's text (its stack) names. */
function stackFiles(text: string | null, root: string, known: ReadonlySet<string>): Set<string> {
  const named = new Set<string>();
  if (text === null) return named;
  const paths: string[] = [];
  for (const m of text.match(FILE_URL) ?? []) {
    try {
      paths.push(fileURLToPath(m.replace(/(?::\d+){1,2}$/, '')));
    } catch {
      // not a file URL a path can be made of
    }
  }
  paths.push(...(text.match(POSIX_PATH) ?? []), ...(text.match(WINDOWS_PATH) ?? []));
  for (const p of paths) {
    const rel = repoRelative(root, p);
    if (rel !== null && known.has(rel)) named.add(rel);
  }
  return named;
}

/** A file-less test named by a path (a test file that failed to load, as the command named it): that path, relative to the root. */
function ownPath(root: string, name: string): string | null {
  if (!new RegExp(`\\.${SOURCE_EXT}$`).test(name)) return null;
  return repoRelative(root, isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) ? name : resolve(root, name));
}

/** The attribution for tests run in `root` whose files are under `scope` (a module's directory, or the root). */
export function attributeByDeclaration({ root, scope }: { root: string; scope: string }): JUnitFileAttribution {
  return (tests: readonly FilelessTest[]) => {
    const files = testFiles(resolve(root), resolve(scope));
    if (files === null) return tests.map(() => null);
    const byRel = new Map(files.map((f) => [f.rel, f]));
    const known = new Set(byRel.keys());
    const loadFailures = new Set<number>();
    const templated = new Set<number>();
    const out = tests.map((t, i): string | null => {
      const titled = files.filter((f) => f.titles.has(t.name));
      if (t.suites.length === 0 && titled.length === 0) {
        const own = ownPath(root, t.name);
        if (own !== null && known.has(own)) {
          loadFailures.add(i);
          return own;
        }
      }
      // Every file that could have run it: a static declaration, or a template-titled one that carries the title.
      const candidates = files.filter((f) => (f.titles.has(t.name) || f.templates.some((tpl) => templateMatches(tpl, t.name))) && t.suites.every((s) => f.suites.has(s)));
      if (candidates.length !== 1) return null;
      const file = candidates[0] as TestFile;
      const named = stackFiles(t.failure, root, known);
      if (named.size > 0 && !named.has(file.rel)) return null;
      if (!file.titles.has(t.name)) templated.add(i);
      return file.rel;
    });
    // Only as often as declared: a static title reported more often than its file declares it is no one test of that
    // file (a template-titled test may run once per value of a loop).
    const seen = new Map<string, number>();
    out.forEach((rel, i) => {
      if (rel !== null && !loadFailures.has(i) && !templated.has(i)) seen.set(`${rel}\0${(tests[i] as FilelessTest).name}`, (seen.get(`${rel}\0${(tests[i] as FilelessTest).name}`) ?? 0) + 1);
    });
    return out.map((rel, i) => {
      if (rel === null || loadFailures.has(i) || templated.has(i)) return rel;
      const name = (tests[i] as FilelessTest).name;
      return (seen.get(`${rel}\0${name}`) ?? 0) > ((byRel.get(rel) as TestFile).titles.get(name) ?? 0) ? null : rel;
    });
  };
}
