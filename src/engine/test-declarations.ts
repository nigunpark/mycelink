/**
 * Declared tests in test files, and the tests a delta adds, changes or
 * removes.
 *
 * The controller reads a node's test changes from the repository, never
 * from running them, to tell a test-first cycle from a test added after
 * production. A test counts as changed when its declaration block (from its
 * declaration to the next one) changed. The JavaScript and Java readers
 * follow the independent benchmark verifier's (evals-public-projects
 * lib/testids.mjs) so the two agree on what a declared test is:
 *
 * - JS/TS: `it(...)` / `test(...)` with modifiers (`.only`, `.skip`, ...)
 *   whose first argument is a static string; strings and comments are
 *   skipped; `.each` / `.for` tables are ignored.
 * - Java/Kotlin: methods annotated `@Test`, `@ParameterizedTest`,
 *   `@RepeatedTest`, `@TestFactory` or `@TestTemplate`.
 * - Python `def test_*`, Go `func Test*` (and Benchmark/Example/Fuzz),
 *   Rust `#[test]` / `#[<runtime>::test]` functions, C# `[Fact]`,
 *   `[Theory]`, `[Test]`, `[TestMethod]`, `[TestCase]` methods.
 *
 * A test file of another code language is *opaque*: Mycelink cannot tell
 * which tests it declares, so any change to it is reported as such and
 * never silently treated as "no test". Data files (configuration,
 * fixtures, snapshots, resources) declare no tests.
 */

export interface DeclaredTest {
  name: string;
  /** The declaration and everything up to the next one, trailing space trimmed. */
  block: string;
}

export interface TestRef {
  file: string;
  name: string;
}

export interface DeltaEntry {
  path: string;
  /** Content before the change; null when the file did not exist. */
  before: string | null;
  /** Content after the change; null when the file was removed. */
  after: string | null;
}

export interface DeltaTests {
  /** Tests the delta adds or whose block it changes. */
  declared: TestRef[];
  /** Changed test files whose language Mycelink cannot read. */
  opaque: string[];
  /** Tests the delta removes. */
  removed: TestRef[];
}

export type TestLanguage = 'js' | 'java' | 'python' | 'go' | 'rust' | 'csharp' | 'data' | 'opaque';

const DATA_EXTENSIONS = new Set([
  'json', 'json5', 'jsonl', 'ndjson', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'xml', 'xsd', 'wsdl', 'sql', 'csv', 'tsv', 'txt', 'md', 'markdown', 'rst', 'adoc', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'pdf',
  'zip', 'gz', 'tgz', 'jar', 'snap', 'jmx', 'graphql', 'gql', 'proto', 'avsc', 'lock', 'log', 'sample',
  'tmpl', 'template', 'mustache', 'hbs', 'ejs', 'pem', 'crt', 'key', 'der', 'bin', 'dat', 'gitkeep',
]);

/** Which reader a test file needs. */
export function testLanguage(path: string): TestLanguage {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const ext = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (ext === '' || DATA_EXTENSIONS.has(ext)) return 'data';
  if (['mjs', 'cjs', 'js', 'jsx', 'ts', 'mts', 'cts', 'tsx'].includes(ext)) return 'js';
  if (['java', 'kt', 'kts'].includes(ext)) return 'java';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (ext === 'cs') return 'csharp';
  return 'opaque';
}

/**
 * Scan JS/TS source: returns the source with strings and comments blanked
 * out (offsets kept) and the string literals by start offset.
 */
function scanJs(src: string): { masked: string; literals: Map<number, { value: string; static: boolean }> } {
  const masked = src.split('');
  const literals = new Map<number, { value: string; static: boolean }>();
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (masked[k] !== '\n') masked[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          value += src[j + 1] ?? '';
          j += 2;
        } else value += src[j++];
      }
      literals.set(i, { value, static: true });
      blank(i, j + 1);
      i = j + 1;
    } else if (c === '`') {
      let j = i + 1;
      let value = '';
      let isStatic = true;
      let depth = 0;
      while (j < src.length) {
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '\\') {
          value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (depth === 0 && src[j] === '$' && src[j + 1] === '{') {
          isStatic = false;
          depth = 1;
          j += 2;
          continue;
        }
        if (depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
          continue;
        }
        value += src[j++];
      }
      literals.set(i, { value, static: isStatic });
      blank(i, j + 1);
      i = j + 1;
    } else {
      i++;
    }
  }
  return { masked: masked.join(''), literals };
}

function declaredJsTests(src: string): { name: string; start: number }[] {
  const { masked, literals } = scanJs(src);
  const found: { name: string; start: number }[] = [];
  const re = /(?<![\w$.])(?:it|test)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const modifiers = (m[1] ?? '').replace(/\s/g, '').split('.').filter(Boolean);
    if (modifiers.some((x) => x === 'each' || x === 'for')) continue;
    // Literals are blanked in `masked`; find the first argument in the source.
    let at = m.index + m[0].length;
    while (at < src.length && /\s/.test(src[at] as string)) at++;
    const literal = literals.get(at);
    if (!literal || !literal.static) continue;
    found.push({ name: literal.value, start: m.index });
  }
  return found;
}

/**
 * Suites a JS/TS source declares with a static name (`describe(...)`,
 * `suite(...)`, with modifiers), in source order; names built by
 * interpolation or `.each` tables are not read.
 */
export function declaredJsSuites(src: string): string[] {
  const { masked, literals } = scanJs(src);
  const found: string[] = [];
  const re = /(?<![\w$.])(?:describe|suite)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const modifiers = (m[1] ?? '').replace(/\s/g, '').split('.').filter(Boolean);
    if (modifiers.some((x) => x === 'each' || x === 'for')) continue;
    let at = m.index + m[0].length;
    while (at < src.length && /\s/.test(src[at] as string)) at++;
    const literal = literals.get(at);
    if (!literal || !literal.static) continue;
    found.push(literal.value);
  }
  return found;
}

/** C-like source with comments and string/char literals blanked out (offsets kept). */
export function maskCLike(src: string, options: { rawBackticks?: boolean; textBlocks?: boolean } = {}): string {
  const masked = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (masked[k] !== '\n') masked[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (options.textBlocks !== false && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? src.length : end + 3;
      blank(i, stop);
      i = stop;
    } else if (options.rawBackticks === true && src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end < 0 ? src.length : end + 1;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else i++;
  }
  return masked.join('');
}

const JAVA_TEST =
  /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b(?:\s*\((?:[^()]|\([^()]*\))*\))?(?:\s*@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?)*\s*(?:(?:public|protected|private|static|final|synchronized|internal|override|open|suspend)\s+)*(?:<[^>]+>\s*)?[\w.$<>[\],? ]+?\s+(\w+)\s*\(/g;

const RUST_TEST = /#\[(?:[A-Za-z_]\w*::)*test(?:\([^)]*\))?\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/g;

const CSHARP_TEST =
  /\[(?:Fact|Theory|Test|TestMethod|DataTestMethod|TestCase)\b(?:\((?:[^()]|\([^()]*\))*\))?\](?:\s*\[[^\]]*\])*\s*(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|unsafe)\s+)*[\w<>[\],.?]+\s+(\w+)\s*\(/g;

const GO_TEST = /^func[ \t]+(?:\([^)]*\)[ \t]*)?((?:Test|Benchmark|Example|Fuzz)\w*)[ \t]*(?:\[[^\]]*\])?\(/gm;

function regexTests(masked: string, re: RegExp): { name: string; start: number }[] {
  const found: { name: string; start: number }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(masked); m; m = re.exec(masked)) found.push({ name: m[1] as string, start: m.index });
  re.lastIndex = 0;
  return found;
}

/**
 * The Java/Kotlin test methods of masked source (maskCLike), exactly the ones declaredTests reads: where each
 * declaration starts (its first test annotation), its name, and where its parameter list opens.
 */
export function javaTestMethods(masked: string): { start: number; name: string; open: number }[] {
  const found: { start: number; name: string; open: number }[] = [];
  JAVA_TEST.lastIndex = 0;
  for (let m = JAVA_TEST.exec(masked); m; m = JAVA_TEST.exec(masked)) found.push({ start: m.index, name: m[1] as string, open: m.index + m[0].length - 1 });
  JAVA_TEST.lastIndex = 0;
  return found;
}

/** Python source with comments and string literals (triple-quoted included) blanked out. */
function maskPython(src: string): string {
  const masked = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (masked[k] !== '\n') masked[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      const stop = end < 0 ? src.length : end + 3;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else i++;
  }
  return masked.join('');
}

const PYTHON_TEST = /^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(/gm;

/** Tests declared in one source file: `[{ name, block }]` in source order. */
export function declaredTests(path: string, source: string): DeclaredTest[] {
  let found: { name: string; start: number }[];
  switch (testLanguage(path)) {
    case 'js':
      found = declaredJsTests(source);
      break;
    case 'java':
      found = regexTests(maskCLike(source), JAVA_TEST);
      break;
    case 'python':
      found = regexTests(maskPython(source), PYTHON_TEST);
      break;
    case 'go':
      found = regexTests(maskCLike(source, { rawBackticks: true, textBlocks: false }), GO_TEST);
      break;
    case 'rust':
      found = regexTests(maskCLike(source, { textBlocks: false }), RUST_TEST);
      break;
    case 'csharp':
      found = regexTests(maskCLike(source), CSHARP_TEST);
      break;
    default:
      found = [];
  }
  return found.map((t, i) => ({ name: t.name, block: source.slice(t.start, found[i + 1]?.start ?? source.length).trimEnd() }));
}

/** Structural closers and whitespace a block ends with: what a test appended after it moves out of its block. */
const CLOSERS = /[\s)}\];,]+$/;

/**
 * Whether a prior test's body survives in its new block: the old block,
 * its trailing closers dropped, starts the new one, followed by nothing but
 * closers or whitespace. A test appended after the last one (inside the same
 * describe) takes the closers with it; an edited assertion — even one
 * character more, `1` to `10` — does not survive.
 */
export function bodyPreserved(before: string, after: string): boolean {
  const core = before.replace(CLOSERS, '');
  if (!after.startsWith(core)) return false;
  const next = after.charAt(core.length);
  return next === '' || /[\s)}\];,]/.test(next);
}

/**
 * What a delta did to the tests that were there before it — all a
 * compatibility-regression unit may not do (engine/tdd-history.ts): remove
 * a test, edit a test's body (weaken it), delete a test file, change an
 * existing test data file, change test code Mycelink cannot read. A new
 * test, and a new data file, are additions.
 */
export function priorTestChanges(delta: readonly DeltaEntry[]): { removed: TestRef[]; edited: TestRef[]; deleted: string[]; data: string[]; opaque: string[] } {
  const out = { removed: [] as TestRef[], edited: [] as TestRef[], deleted: [] as string[], data: [] as string[], opaque: [] as string[] };
  for (const { path, before, after } of delta) {
    if (before === null || before === after) continue;
    if (after === null) out.deleted.push(path);
    const language = testLanguage(path);
    if (language === 'data') {
      if (after !== null) out.data.push(path);
      continue;
    }
    if (language === 'opaque') {
      out.opaque.push(path);
      continue;
    }
    const now = new Map<string, string>();
    for (const t of after !== null ? declaredTests(path, after) : []) if (!now.has(t.name)) now.set(t.name, t.block);
    const seen = new Set<string>();
    for (const t of declaredTests(path, before)) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      const block = now.get(t.name);
      if (block === undefined) out.removed.push({ file: path, name: t.name });
      else if (block !== t.block && !bodyPreserved(t.block, block)) out.edited.push({ file: path, name: t.name });
    }
  }
  return out;
}

/**
 * A JS/TS test whose title is a template literal with interpolations
 * (`it(\`restores ${label} ...\`)`, usually in a loop or a helper): its
 * template, as written between the backticks, and its declaration block.
 * Never a declared test — no static reader can name what it runs as (CSET-203
 * r17: R005's exact reproduction, two cases of one such title, declared
 * nothing). Only a reproduction capsule's run names its tests; the template
 * locates the block their assertions are in (engine/reproduction-capsule.ts).
 */
export interface DeclaredTemplate {
  template: string;
  block: string;
}

/**
 * Every test declaration of one source file, static and template-titled, in source order: a static one by its name,
 * a template-titled one by its template; each block bounded by the next declaration of either kind.
 */
export function declarationBlocks(path: string, source: string): { kind: 'static' | 'template'; key: string; block: string }[] {
  const statics = declaredTests(path, source).map((t) => ({ kind: 'static' as const, key: t.name, start: source.indexOf(t.block) }));
  const templates = declaredTestTemplates(path, source).map((t) => ({ kind: 'template' as const, key: t.template, start: source.indexOf(t.block) }));
  const all = [...statics, ...templates].filter((d) => d.start >= 0).sort((a, b) => a.start - b.start);
  return all.map((d, i) => ({ kind: d.kind, key: d.key, block: source.slice(d.start, all[i + 1]?.start ?? source.length).trimEnd() }));
}

/** The template-titled tests of one JS/TS source file, in source order, each with its block up to the next declaration of any kind. */
export function declaredTestTemplates(path: string, source: string): DeclaredTemplate[] {
  if (testLanguage(path) !== 'js') return [];
  const { masked } = scanJs(source);
  const starts: { start: number; template: string | null }[] = [];
  const re = /(?<![\w$.])(?:it|test)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const modifiers = (m[1] ?? '').replace(/\s/g, '').split('.').filter(Boolean);
    if (modifiers.some((x) => x === 'each' || x === 'for')) continue;
    let at = m.index + m[0].length;
    while (at < source.length && /\s/.test(source[at] as string)) at++;
    starts.push({ start: m.index, template: source[at] === '`' ? templateAt(source, at) : null });
  }
  return starts.flatMap((s, i) => (s.template === null ? [] : [{ template: s.template, block: source.slice(s.start, starts[i + 1]?.start ?? source.length).trimEnd() }]));
}

/** The raw text of the template literal opening at `open`, when it interpolates; null for a static one (a declared test) or one that does not close. */
function templateAt(source: string, open: number): string | null {
  let depth = 0;
  let interpolates = false;
  for (let j = open + 1; j < source.length; j++) {
    const c = source[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (depth === 0 && c === '`') return interpolates ? source.slice(open + 1, j) : null;
    if (depth === 0 && c === '$' && source[j + 1] === '{') {
      interpolates = true;
      depth = 1;
      j++;
      continue;
    }
    if (depth > 0 && c === '{') depth++;
    else if (depth > 0 && c === '}') depth--;
  }
  return null;
}

/** Whether `name` is a title `template` can produce: its static parts exactly, each interpolation at least one character. */
export function templateMatches(template: string, name: string): boolean {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i] as string;
    if (depth === 0 && c === '\\') {
      current += template[i + 1] ?? '';
      i++;
    } else if (depth === 0 && c === '$' && template[i + 1] === '{') {
      parts.push(current);
      current = '';
      depth = 1;
      i++;
    } else if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    } else current += c;
  }
  parts.push(current);
  if (parts.length < 2) return false;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${parts.map(escape).join('.+?')}$`, 's').test(name);
}

/**
 * Tests a delta adds, changes or removes; changed test files of a language
 * Mycelink cannot read are `opaque`. Data files declare nothing. Results are
 * in delta order, then declaration order, without duplicates.
 */
export function testsInDelta(delta: readonly DeltaEntry[]): DeltaTests {
  const out: DeltaTests = { declared: [], opaque: [], removed: [] };
  for (const { path, before, after } of delta) {
    const language = testLanguage(path);
    if (language === 'data') continue;
    if (language === 'opaque') {
      if (before !== after) out.opaque.push(path);
      continue;
    }
    const previous = new Map<string, string>();
    for (const t of before !== null ? declaredTests(path, before) : []) if (!previous.has(t.name)) previous.set(t.name, t.block);
    const seen = new Set<string>();
    for (const t of after !== null ? declaredTests(path, after) : []) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      if (!previous.has(t.name) || previous.get(t.name) !== t.block) out.declared.push({ file: path, name: t.name });
    }
    for (const name of previous.keys()) if (!seen.has(name)) out.removed.push({ file: path, name });
  }
  return out;
}
