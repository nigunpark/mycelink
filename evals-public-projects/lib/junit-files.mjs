/**
 * Which test file a Node JUnit result is from, when the report does not say.
 *
 * Node's JUnit reporter names each test's file (`file="..."`) from Node 24.11
 * on; Node 22's names none, and two same-named tests of two files look alike
 * (CI 38347201692: every toy test read "not run" on Node 22.12.0, and no toy
 * qualified). As Mycelink attributes them (src/evidence/junit-attribution.ts),
 * but among exactly the files the run named:
 *
 *  - a test file that failed before any test registered is reported under its
 *    own path: that file, when the run named it and no test is titled so;
 *  - any other test, the one file of the run that declares it — its title as
 *    a static test name, or a template-titled test whose template carries it
 *    — with every suite of its chain as a static suite name (lib/testids.mjs);
 *    a static title only as often as that file declares it; never when
 *    another file of the run could have run it, and never when its failure's
 *    stack names another file of the run.
 *
 * Anything else names no file, and matches no expected test (fail closed).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredJsSuites, declaredJsTemplates, declaredTests, templateMatches } from './testids.mjs';
import { repoRelative } from './results.mjs';

const SOURCE_EXT = '(?:mjs|cjs|js|jsx|ts|mts|cts|tsx)';
const FILE_URL = /file:\/\/[^\s)'"<>]+/g;
const POSIX_PATH = new RegExp(`(?<=[\\s(]|^)/[^\\s:()'"<>]+\\.${SOURCE_EXT}(?=[:)\\s]|$)`, 'gm');
const WINDOWS_PATH = new RegExp(`[A-Za-z]:\\\\[^\\s:()'"<>]+\\.${SOURCE_EXT}(?=[:)\\s]|$)`, 'gm');

/** The run's files a failure's text (its stack) names. */
function stackFiles(text, root, known) {
  const named = new Set();
  if (!text) return named;
  const paths = [];
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

/** For `parseJUnit`'s `attribute`: the files of a run in `root` that named exactly `files` (repository-relative). */
export function attributeAmong({ root, files }) {
  return (tests) => {
    const sources = [];
    for (const rel of [...new Set(files)].sort()) {
      let source;
      try {
        source = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const titles = new Map();
      for (const t of declaredTests(rel, source)) titles.set(t.name, (titles.get(t.name) ?? 0) + 1);
      sources.push({ rel, titles, suites: new Set(declaredJsSuites(source)), templates: declaredJsTemplates(source) });
    }
    const known = new Set(sources.map((s) => s.rel));
    const loadFailures = new Set();
    const templated = new Set();
    const out = tests.map((t, i) => {
      const titled = sources.filter((s) => s.titles.has(t.name));
      if (t.suites.length === 0 && titled.length === 0 && new RegExp(`\\.${SOURCE_EXT}$`).test(t.name)) {
        const own = repoRelative(root, isAbsolute(t.name) || /^[A-Za-z]:[\\/]/.test(t.name) ? t.name : resolve(root, t.name));
        if (own !== null && known.has(own)) {
          loadFailures.add(i);
          return own;
        }
      }
      // Every file of the run that could have run it: a static declaration, or a template-titled one carrying the title.
      const candidates = sources.filter((s) => (s.titles.has(t.name) || s.templates.some((tpl) => templateMatches(tpl, t.name))) && t.suites.every((x) => s.suites.has(x)));
      if (candidates.length !== 1) return null;
      const file = candidates[0];
      const named = stackFiles(t.failure, root, known);
      if (named.size > 0 && !named.has(file.rel)) return null;
      if (!file.titles.has(t.name)) templated.add(i);
      return file.rel;
    });
    // A static title only as often as declared (a template-titled test may run once per value of a loop).
    const seen = new Map();
    out.forEach((rel, i) => {
      if (rel !== null && !loadFailures.has(i) && !templated.has(i)) seen.set(`${rel}\0${tests[i].name}`, (seen.get(`${rel}\0${tests[i].name}`) ?? 0) + 1);
    });
    return out.map((rel, i) => {
      if (rel === null || loadFailures.has(i) || templated.has(i)) return rel;
      const declared = sources.find((s) => s.rel === rel).titles.get(tests[i].name) ?? 0;
      return (seen.get(`${rel}\0${tests[i].name}`) ?? 0) > declared ? null : rel;
    });
  };
}
