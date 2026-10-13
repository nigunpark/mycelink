/**
 * Runner-aware canonical test identity: what makes two references to a test
 * the same test.
 *
 * PCM-101 final (normal arm, trusted): both Java producers ran a valid RED,
 * GREEN and full regression, yet settle refused every criterion with
 * CRITERION_TEST_UNKNOWN. The stale-RED guard compared a JUnit result's name
 * as Surefire publishes it — its class, `#`, its method:
 * `org.springframework....VisitVetTest#createWithVet...` — with the bare
 * method the Java reader declares, as strings; two forms of one name never
 * match, so no Java test could be declared at any head. One identity is now
 * used wherever a test is matched (the source declaration, the report, a RED
 * binding, a criterion's reference, the completion ledger and its re-proofs,
 * the coverage manifest): its normalised source path and a key of its runner.
 *
 *  - JUnit (Java, Kotlin): the method. The package and class are stripped
 *    from `Class#method` and kept as raw evidence; the class must be the
 *    file's own (the path ends with its package and top-level class, and the
 *    file declares it). A nested class (`Outer$Inner`), parameter types
 *    (`m(int)`) and an invocation's index or display (`m(int)[1] 1, a`) are
 *    read from the report: they tell same-named methods and overloads apart.
 *    A bare name they cannot tell apart, a class the file does not declare, a
 *    name no test method carries, a malformed `#` — never guessed: it fails
 *    closed.
 *  - JS (Vitest, Jest, node:test): the full suite/title name, as before.
 *  - Every other runner: exact.
 *
 * A test id (evidence/test-ids.ts) stays what it was: a handle to one result
 * of one report. The identity is what compares tests across reports and
 * against the source, versioned (TEST_IDENTITY_VERSION) beside the raw name.
 */
import { declaredTestTemplates, declaredTests, javaTestMethods, maskCLike, templateMatches, testLanguage } from '../engine/test-declarations.js';
import { normalizeTestPath } from './test-ids.js';

export const TEST_IDENTITY_VERSION = 'mycelink-test-identity/1' as const;

export type TestRunner = 'junit' | 'js' | 'exact';

/** A test's canonical identity. */
export interface TestIdentity {
  version: typeof TEST_IDENTITY_VERSION;
  runner: TestRunner;
  /** Repository-relative, '/'-separated. */
  path: string;
  /** JUnit: the method, its package and class stripped. JS and exact: the full name as the runner reports it. */
  key: string;
  /** JUnit: the class chain the test belongs to, top-level class first, package dropped. */
  classes?: string[];
  /** JUnit: its parameter types (simple names), when the report or an overload names them. */
  params?: string[];
}

/** A test as a gate's results name it: its path, the framework's full name, its own name and (JUnit) its class. */
export interface ReportedTest {
  path: string;
  full_name: string;
  name?: string | undefined;
  classname?: string | null | undefined;
}

/** Which identity a test path's runner gives its tests. */
export function runnerOf(path: string): TestRunner {
  const language = testLanguage(path);
  if (language === 'java') return 'junit';
  if (language === 'js') return 'js';
  return 'exact';
}

// ---- JUnit names ------------------------------------------------------------------------------------------------

/** A JUnit reference, read from a report's `<class>#<name>` (or a bare name). */
export interface JUnitReference {
  /** The package it names: '' for none in its class (the default package), null when it names no class at all. */
  pkg: string | null;
  /** Its class chain, top-level class first, package dropped; [] when it names no class. */
  classes: string[];
  /** The method, or null when the name is not one (a display name). */
  method: string | null;
  /** The parameter types it names (`m(int, String)`), simple names; null when it names none. */
  params: string[] | null;
  /** What follows the method and its parameters: an invocation's `[1]`, `[2] 2, two`; '' when nothing does. */
  suffix: string;
  /** The test's name as reported (after `#`). */
  name: string;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A type as JUnit reports a parameter of it: its simple name, generics erased, varargs as an array. */
function simpleType(type: string): string {
  let t = type.replace(/@[\w.$]+(?:\s*\([^)]*\))?\s*/g, '').replace(/\bfinal\s+/g, '').trim();
  for (let before = ''; before !== t; ) {
    before = t;
    t = t.replace(/<[^<>]*>/g, '');
  }
  t = t.replace(/\s+/g, '');
  if (t.endsWith('...')) t = `${t.slice(0, -3)}[]`;
  const dims = (t.match(/\[\]/g) ?? []).length;
  t = t.replace(/\[\]/g, '');
  t = (t.slice(t.lastIndexOf('.') + 1).split('$').pop() as string) || t;
  return `${t}${'[]'.repeat(dims)}`;
}

/** A binary class name, `pkg.Outer$Inner`: its package and class chain, or null when it is none. */
function binaryClass(classname: string): { pkg: string; classes: string[] } | null {
  const dot = classname.lastIndexOf('.');
  const pkg = dot < 0 ? '' : classname.slice(0, dot);
  const simple = dot < 0 ? classname : classname.slice(dot + 1);
  if (pkg !== '' && !pkg.split('.').every((p) => IDENT.test(p))) return null;
  const classes = simple.split('$');
  return classes.every((c) => IDENT.test(c)) ? { pkg, classes } : null;
}

/** A reported name: `m`, `m()`, `m(T, U)`, `m[1]`, `m(T)[1] display`. Anything else is a display name: no method. */
function memberOf(name: string): Pick<JUnitReference, 'method' | 'params' | 'suffix'> {
  const m = /^([A-Za-z_$][\w$]*)(?:\(([^()]*)\))?(\[[\s\S]*)?$/.exec(name);
  if (m === null) return { method: null, params: null, suffix: '' };
  const params = m[2] === undefined ? null : m[2].trim() === '' ? [] : m[2].split(',').map((p) => simpleType(p.trim()));
  return { method: m[1] as string, params, suffix: m[3] ?? '' };
}

/**
 * A JUnit reference from a reported test (its class and name when the report kept them apart, else its full name) or a
 * string. Null when it is malformed: an empty class or name around `#`, a `#` in the name, a class that is no binary
 * class name.
 */
export function parseJUnitReference(ref: ReportedTest | string): JUnitReference | null {
  let classname: string | null;
  let name: string;
  if (typeof ref !== 'string' && typeof ref.classname === 'string' && ref.classname !== '' && typeof ref.name === 'string') {
    classname = ref.classname;
    name = ref.name;
  } else {
    const full = typeof ref === 'string' ? ref : ref.full_name;
    const hash = full.indexOf('#');
    classname = hash < 0 ? null : full.slice(0, hash);
    name = hash < 0 ? full : full.slice(hash + 1);
  }
  if (name === '' || name.includes('#') || classname === '') return null;
  const cls = classname === null ? null : binaryClass(classname);
  if (classname !== null && cls === null) return null;
  return { pkg: cls?.pkg ?? null, classes: cls?.classes ?? [], ...memberOf(name), name };
}

/** The identity a report alone gives a test (no source read): null for a JUnit name no method can be read from. */
export function reportedIdentity(test: ReportedTest): TestIdentity | null {
  const path = normalizeTestPath(test.path);
  const runner = runnerOf(path);
  if (runner !== 'junit') return { version: TEST_IDENTITY_VERSION, runner, path, key: test.full_name };
  const ref = parseJUnitReference(test);
  if (ref === null || ref.method === null) return null;
  return { version: TEST_IDENTITY_VERSION, runner, path, key: ref.method, ...(ref.classes.length > 0 ? { classes: ref.classes } : {}), ...(ref.params !== null ? { params: ref.params } : {}) };
}

/** Whether two identities are the same test: one runner, path and key, and (JUnit) class chain and parameters where both name them. */
export function sameTest(a: TestIdentity, b: TestIdentity): boolean {
  if (a.version !== b.version || a.runner !== b.runner || a.path !== b.path || a.key !== b.key) return false;
  if (a.runner !== 'junit') return true;
  if ((a.classes ?? []).length > 0 && (b.classes ?? []).length > 0 && (a.classes as string[]).join('$') !== (b.classes as string[]).join('$')) return false;
  if (a.params !== undefined && b.params !== undefined && a.params.join(',') !== b.params.join(',')) return false;
  return true;
}

/** A test's own title, as a source declares it: JUnit, its method (a display name as reported); JS and exact, its last ` > ` segment. */
export function testTitle(path: string, fullName: string): string {
  if (runnerOf(path) === 'junit') {
    const ref = parseJUnitReference(fullName);
    return ref === null ? fullName : (ref.method ?? ref.name);
  }
  return fullName.includes(' > ') ? (fullName.split(' > ').pop() as string) : fullName;
}

/** A reported test's own name as its report published it: JUnit, after `#` (`m(int)[1]`); JS and exact, its last ` > ` segment. */
export function reportedName(path: string, fullName: string): string {
  if (runnerOf(path) === 'junit') {
    const hash = fullName.indexOf('#');
    return hash < 0 ? fullName : fullName.slice(hash + 1);
  }
  return fullName.includes(' > ') ? (fullName.split(' > ').pop() as string) : fullName;
}

/** Whether a reported test is the test a reader declared by `declared` (a name declaredTests found), runner-aware. */
export function namesDeclaration(path: string, fullName: string, declared: string): boolean {
  if (runnerOf(path) === 'junit') return testTitle(path, fullName) === declared;
  return fullName === declared || fullName.endsWith(` > ${declared}`);
}

// ---- Java test declarations ----------------------------------------------------------------------------------------

export interface JavaTestDeclaration {
  name: string;
  /** The class chain it is declared in, top-level class first. */
  classes: string[];
  /** Its parameter types (simple names); null when they cannot be read. */
  params: string[] | null;
  /** Its `@DisplayName`, when it carries one. */
  display: string | null;
  /** 1-based line of its name. */
  line: number;
}

/** The brace closing the one at `open`, in masked source. */
function closing(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return i;
  }
  return masked.length;
}

/** Split at commas outside (), <> and []. */
function topLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '<' || c === '[') depth++;
    else if (c === ')' || c === '>' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(at, i));
      at = i + 1;
    }
  }
  out.push(text.slice(at));
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

/** The parameter types of the list opening at `open` (masked), or null when it does not close. */
function parameterTypes(masked: string, open: number): string[] | null {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')' && --depth === 0) {
      return topLevelCommas(masked.slice(open + 1, i)).map((p) => {
        // Kotlin: `name: Type`. Java: `[annotations] [final] Type name` (or `Type name[]`).
        if (p.includes(':')) return simpleType(p.slice(p.indexOf(':') + 1));
        const bare = p.replace(/@[\w.$]+(?:\s*\([^)]*\))?\s*/g, '').replace(/\bfinal\s+/g, '').trim();
        const m = /^([\s\S]*?)\s*([A-Za-z_$][\w$]*)\s*((?:\[\s*\])*)$/.exec(bare);
        return m === null ? simpleType(bare) : simpleType(`${m[1]}${(m[3] ?? '').replace(/\s+/g, '')}`);
      });
    }
  }
  return null;
}

/** The annotations directly before `at` (masked): their spans, nearest first. */
function annotationsBefore(masked: string, at: number): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let pos = at;
  for (let guard = 0; guard < 32; guard++) {
    let i = pos;
    while (i > 0 && /\s/.test(masked[i - 1] as string)) i--;
    let end = i;
    if (masked[i - 1] === ')') {
      let depth = 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        if (masked[j] === ')') depth++;
        else if (masked[j] === '(' && --depth === 0) break;
      }
      if (j < 0) break;
      i = j;
      while (i > 0 && /\s/.test(masked[i - 1] as string)) i--;
    }
    let k = i;
    while (k > 0 && /[\w.$]/.test(masked[k - 1] as string)) k--;
    if (k === i || masked[k - 1] !== '@') break;
    spans.push({ from: k - 1, to: end });
    pos = k - 1;
    end = pos;
  }
  return spans;
}

/** A Java string literal's value. */
function javaString(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/\\'/g, "'")}"`) as string;
  } catch {
    return raw;
  }
}

const DISPLAY_NAME = /@DisplayName\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/;

/** The class scopes and test methods of a Java/Kotlin source, in source order. */
function javaStructure(source: string): { classes: { name: string; open: number; close: number }[]; tests: JavaTestDeclaration[] } {
  const masked = maskCLike(source);
  const classes: { name: string; open: number; close: number }[] = [];
  const decl = /(?<![\w$.])(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g;
  for (let m = decl.exec(masked); m; m = decl.exec(masked)) {
    // Its body: the first `{` after the header outside parentheses (a record's components hold some).
    let depth = 0;
    let open = -1;
    for (let i = m.index + m[0].length; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && c === ';') break;
      else if (depth === 0 && c === '{') {
        open = i;
        break;
      }
    }
    if (open >= 0) classes.push({ name: m[1] as string, open, close: closing(masked, open) });
  }
  const tests = javaTestMethods(masked).map((t): JavaTestDeclaration => {
    const chain = classes.filter((c) => c.open < t.start && t.start < c.close).sort((a, b) => a.open - b.open).map((c) => c.name);
    const spans = [...annotationsBefore(masked, t.start), { from: t.start, to: t.open }];
    const display = spans.map((s) => DISPLAY_NAME.exec(source.slice(s.from, s.to))).find((m) => m !== null);
    const nameAt = masked.lastIndexOf(t.name, t.open);
    return { name: t.name, classes: chain, params: parameterTypes(masked, t.open), display: display ? javaString(display[1] as string) : null, line: source.slice(0, Math.max(0, nameAt)).split('\n').length };
  });
  return { classes, tests };
}

/** The test methods a Java/Kotlin source declares, each with its class chain, parameter types and display name. */
export function javaTestDeclarations(source: string): JavaTestDeclaration[] {
  return javaStructure(source).tests;
}

// ---- resolution against a source ------------------------------------------------------------------------------------

export type DeclarationResolution =
  /** `translated`: the identity is not the reported full name as is (a JUnit class stripped, a display name read) — the old comparison could not have matched it. */
  | { status: 'declared'; identity: TestIdentity; translated: boolean; line: number | null }
  /** The file holds no such test (or is not there). */
  | { status: 'missing'; detail: string }
  /** More than one declaration answers to the reference, and nothing it names tells them apart. */
  | { status: 'ambiguous'; detail: string }
  /** The reference cannot be this file's: malformed, or naming a class the file is not or does not declare. */
  | { status: 'mismatch'; detail: string }
  /** Mycelink cannot read which tests the file declares (another language, a table-driven title). */
  | { status: 'unreadable'; detail: string };

const sameParams = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const chainOf = (classes: readonly string[]): string => classes.join('$');

/** JS and every runner but JUnit: the reported full name, or its last ` > ` segment, exactly as the file declares a test. */
function resolvePlain(path: string, runner: TestRunner, fullName: string, source: string): DeclarationResolution {
  const language = testLanguage(path);
  const title = fullName.includes(' > ') ? (fullName.split(' > ').pop() as string) : fullName;
  const declared = { status: 'declared' as const, identity: { version: TEST_IDENTITY_VERSION, runner, path, key: fullName }, translated: false, line: null };
  if (declaredTests(path, source).some((t) => t.name === title || t.name === fullName)) return declared;
  if (language === 'js' && declaredTestTemplates(path, source).some((t) => templateMatches(t.template, title))) return declared;
  // A table-driven test (`it.each`, `test.for`) names its cases only when it runs: nothing to tell from the file.
  if (language === 'js' && /\.(?:each|for)\s*[(`]/.test(source)) return { status: 'unreadable', detail: `${path} has table-driven tests whose titles only a run names` };
  return { status: 'missing', detail: `${path} declares no test ${JSON.stringify(title)}` };
}

function resolveJUnit(path: string, test: ReportedTest, source: string): DeclarationResolution {
  const ref = parseJUnitReference(test);
  if (ref === null) return { status: 'mismatch', detail: `${JSON.stringify(test.full_name)} is no JUnit test name (<class>#<method>)` };
  const file = path.slice(path.lastIndexOf('/') + 1);
  const base = file.replace(/\.(?:java|kts?)$/i, '');
  const { classes: scopes, tests } = javaStructure(source);
  if (ref.classes.length > 0) {
    const top = ref.classes[0] as string;
    if (top !== base) return { status: 'mismatch', detail: `${top} is not the class of ${path}` };
    if (ref.pkg !== null && ref.pkg !== '') {
      const dir = path.slice(0, Math.max(0, path.length - file.length - 1));
      const want = ref.pkg.split('.').join('/');
      if (dir !== want && !dir.endsWith(`/${want}`)) return { status: 'mismatch', detail: `${ref.pkg}.${top} is not at ${path}` };
    }
    const declaredClasses = new Set(scopes.map((c) => c.name));
    const unknown = ref.classes.find((c) => !declaredClasses.has(c));
    if (unknown !== undefined) return { status: 'mismatch', detail: `${path} declares no class ${unknown}` };
  }
  const inChain = (d: JavaTestDeclaration): boolean => ref.classes.length === 0 || chainOf(d.classes) === chainOf(ref.classes) || ref.classes.length === 1;
  // The method: the one the report names, or the one whose @DisplayName the report carries.
  let method = ref.method;
  let viaDisplay = false;
  if (method === null) {
    const shown = tests.filter((d) => d.display !== null && d.display === ref.name && inChain(d));
    if (shown.length !== 1) return shown.length === 0 ? { status: 'missing', detail: `${path} declares no test named ${JSON.stringify(ref.name)}` } : { status: 'ambiguous', detail: `${shown.length} tests of ${path} carry the display name ${JSON.stringify(ref.name)}` };
    method = (shown[0] as JavaTestDeclaration).name;
    viaDisplay = true;
  }
  let candidates = tests.filter((d) => d.name === method);
  if (candidates.length === 0) return { status: 'missing', detail: `${path} declares no test method ${method}` };
  if (ref.classes.length > 0) {
    const exact = candidates.filter((d) => chainOf(d.classes) === chainOf(ref.classes));
    if (exact.length > 0) candidates = exact;
    else if (ref.classes.length > 1) return { status: 'missing', detail: `${ref.classes.join('$')} declares no test method ${method}` };
  }
  // Reported under the file's own class or by its bare name: a nested declaration is it only when no other class of the file has one.
  const chains = [...new Set(candidates.map((d) => chainOf(d.classes)))];
  if (chains.length > 1) return { status: 'ambiguous', detail: `${method} is a test of ${chains.join(' and ')} in ${path}; the report names no class that tells them apart` };
  // Overloads in one class: told apart only by the parameters the report names.
  if (candidates.length > 1) {
    if (ref.params === null) return { status: 'ambiguous', detail: `${method} is overloaded in ${chains[0]} (${candidates.map((d) => `${method}(${(d.params ?? ['?']).join(', ')})`).join(', ')}); the report names no parameters` };
    const byParams = candidates.filter((d) => d.params !== null && sameParams(d.params, ref.params as string[]));
    if (byParams.length !== 1) return byParams.length === 0 ? { status: 'missing', detail: `${path} declares no ${method}(${ref.params.join(', ')})` } : { status: 'ambiguous', detail: `${byParams.length} declarations of ${method}(${ref.params.join(', ')}) in ${path}` };
    candidates = byParams;
  } else {
    const only = candidates[0] as JavaTestDeclaration;
    if (ref.params !== null && only.params !== null && !sameParams(only.params, ref.params)) return { status: 'missing', detail: `${path} declares ${method}(${only.params.join(', ')}), not ${method}(${ref.params.join(', ')})` };
  }
  const d = candidates[0] as JavaTestDeclaration;
  const overloaded = tests.filter((x) => x.name === d.name && chainOf(x.classes) === chainOf(d.classes)).length > 1;
  const params = overloaded || ref.params !== null ? (d.params ?? ref.params) : null;
  const identity: TestIdentity = { version: TEST_IDENTITY_VERSION, runner: 'junit', path, key: d.name, ...(d.classes.length > 0 ? { classes: d.classes } : {}), ...(params !== null ? { params } : {}) };
  return { status: 'declared', identity, translated: viaDisplay || test.full_name !== d.name, line: d.line };
}

/**
 * Whether `source` (the file at `test.path` at some head; null when it is not there) declares the reported test, and
 * as which canonical identity.
 */
export function resolveDeclaration(test: ReportedTest, source: string | null): DeclarationResolution {
  const path = normalizeTestPath(test.path);
  if (source === null) return { status: 'missing', detail: `${path} is not in the head` };
  const language = testLanguage(path);
  if (language === 'opaque' || language === 'data') return { status: 'unreadable', detail: `Mycelink cannot read which tests ${path} declares` };
  const runner = runnerOf(path);
  return runner === 'junit' ? resolveJUnit(path, test, source.replace(/\r\n/g, '\n')) : resolvePlain(path, runner, test.full_name, source);
}
