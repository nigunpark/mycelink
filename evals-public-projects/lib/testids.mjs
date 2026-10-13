/**
 * Declared tests in source files, and the tests a delta adds or changes.
 *
 * The TDD replay derives the tests a RED must fail from the test files the
 * test-first delta touches — never from running them. A test counts when it
 * is new, or when its declaration block (from its declaration to the next
 * one) changed.
 *
 * - JS/TS: `it(...)` / `test(...)` with modifiers (`.only`, `.skip`,
 *   `.todo`, `.concurrent`, ...) whose first argument is a static string.
 *   Strings and comments are skipped, so a test-like call inside a string is
 *   not a test; names built by interpolation or `.each` tables are ignored.
 * - Java: methods annotated `@Test`, `@ParameterizedTest`, `@RepeatedTest`,
 *   `@TestFactory` or `@TestTemplate`.
 */

const JS_EXT = /\.(mjs|cjs|js|jsx|ts|mts|cts|tsx)$/;

/**
 * Scan JS/TS source: returns the source with strings and comments blanked
 * out (offsets kept) and the string literals by start offset.
 */
function scanJs(src) {
  const masked = src.split('');
  const literals = new Map();
  const blank = (from, to) => {
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

function declaredJsTests(src) {
  const { masked, literals } = scanJs(src);
  const found = [];
  const re = /(?<![\w$.])(?:it|test)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const modifiers = m[1].replace(/\s/g, '').split('.').filter(Boolean);
    if (modifiers.some((x) => x === 'each' || x === 'for')) continue;
    // Literals are blanked in `masked`; find the first argument in the source.
    let at = m.index + m[0].length;
    while (at < src.length && /\s/.test(src[at])) at++;
    const literal = literals.get(at);
    if (!literal || !literal.static) continue;
    found.push({ name: literal.value, start: m.index });
  }
  return found;
}

function maskJava(src) {
  const masked = src.split('');
  const blank = (from, to) => {
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
    } else if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end < 0 ? src.length : end + 3;
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
  /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b(?:\s*\((?:[^()]|\([^()]*\))*\))?(?:\s*@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?)*\s*(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:<[^>]+>\s*)?[\w.$<>[\],? ]+?\s+(\w+)\s*\(/g;

function declaredJavaTests(src) {
  const masked = maskJava(src);
  const found = [];
  for (let m = JAVA_TEST.exec(masked); m; m = JAVA_TEST.exec(masked)) found.push({ name: m[1], start: m.index });
  JAVA_TEST.lastIndex = 0;
  return found;
}

/** Tests declared in one source file: `[{ name, block }]` in source order. */
export function declaredTests(path, source) {
  const found = path.endsWith('.java') ? declaredJavaTests(source) : JS_EXT.test(path) ? declaredJsTests(source) : [];
  return found.map((t, i) => ({ name: t.name, block: source.slice(t.start, found[i + 1]?.start ?? source.length).trimEnd() }));
}

/**
 * Tests a delta adds or changes. `delta` is `[{ path, before, after }]`
 * (strings, or null for absent); `isTestPath` selects test files.
 * Returns `[{ file, name }]`, in file and declaration order, without
 * duplicates.
 */
export function testsInDelta(delta, { isTestPath }) {
  const out = [];
  for (const { path, before, after } of delta) {
    if (after === null || after === undefined || !isTestPath(path)) continue;
    const previous = new Map();
    for (const t of before ? declaredTests(path, before) : []) previous.set(t.name, t.block);
    const seen = new Set();
    for (const t of declaredTests(path, after)) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      if (!previous.has(t.name) || previous.get(t.name) !== t.block) out.push({ file: path, name: t.name });
    }
  }
  return out;
}

const CLOSERS = /[\s)}\];,]+$/;

/** A prior test's body survives in its new block: the old block, its trailing closers dropped, starts the new one (as Mycelink's settle judges it). */
function bodyPreserved(before, after) {
  const core = before.replace(CLOSERS, '');
  if (!after.startsWith(core)) return false;
  const next = after.charAt(core.length);
  return next === '' || /[\s)}\];,]/.test(next);
}

const isCode = (path) => path.endsWith('.java') || JS_EXT.test(path);

/**
 * What a delta did to the tests that were there (`[{ path, before, after }]`,
 * test files only): removed or edited (weakened) tests, deleted test files,
 * changed existing test data; and the tests it adds. A compatibility-regression
 * unit may only add (lib/tdd.mjs), in parity with Mycelink's own settle.
 */
export function priorTestChanges(delta, { isTestPath }) {
  const out = { removed: [], edited: [], deleted: [], data: [], added: [] };
  for (const { path, before, after } of delta) {
    if (!isTestPath(path)) continue;
    const now = new Map();
    for (const t of after ? declaredTests(path, after) : []) if (!now.has(t.name)) now.set(t.name, t.block);
    const prior = new Map();
    for (const t of before ? declaredTests(path, before) : []) if (!prior.has(t.name)) prior.set(t.name, t.block);
    for (const name of now.keys()) if (!prior.has(name)) out.added.push({ file: path, name });
    if (before === null || before === undefined || before === after) continue;
    if (after === null || after === undefined) out.deleted.push(path);
    if (!isCode(path)) {
      if (after !== null && after !== undefined) out.data.push(path);
      continue;
    }
    for (const [name, block] of prior) {
      const next = now.get(name);
      if (next === undefined) out.removed.push({ file: path, name });
      else if (next !== block && !bodyPreserved(block, next)) out.edited.push({ file: path, name });
    }
  }
  return out;
}
