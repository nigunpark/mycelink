/**
 * Test results from Node's JUnit reporter, Maven Surefire and Vitest's JSON
 * reporter, normalised to one shape:
 *
 *   { id, file, suite, name, status: 'passed' | 'failed' | 'skipped',
 *     category, type, message, fingerprint }
 *
 * `file` is repository-relative, `name` is the leaf test name and `suite`
 * the enclosing suite chain (' > ' separated). `category` classifies a
 * failure: only 'assertion' and 'exception' (thrown by the code under test)
 * count as evidence that a behaviour is missing; 'syntax', 'import',
 * 'missing-symbol', 'setup', 'timeout', 'crash' and 'not-run' prove nothing
 * about the behaviour and make a RED invalid.
 */
import { relative, isAbsolute } from 'node:path';
import { sha256Hex, canonicalJson } from './hash.mjs';

export const RED_VALID_CATEGORIES = new Set(['assertion', 'exception']);
export const INVALID_RED_CATEGORIES = new Set(['syntax', 'import', 'missing-symbol', 'setup', 'timeout', 'crash', 'not-run']);

// ------------------------------------------------------------------ XML ----

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ent) => {
    if (ent[0] === '#') return String.fromCodePoint(ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10));
    return ENTITIES[ent] ?? whole;
  });
}

/**
 * A small, strict XML parser for test reports: elements, attributes,
 * entities, CDATA, comments and processing instructions. No DTDs.
 * Returns the root `{ name, attrs, children, text }`.
 */
export function parseXml(source) {
  let i = 0;
  const stack = [{ name: '#document', attrs: {}, children: [], text: '' }];
  const top = () => stack[stack.length - 1];
  while (i < source.length) {
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i);
      if (end < 0) throw new Error('unterminated processing instruction');
      i = end + 2;
    } else if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      if (end < 0) throw new Error('unterminated CDATA');
      top().text += source.slice(i + 9, end);
      i = end + 3;
    } else if (source.startsWith('<!', i)) {
      throw new Error('DTDs are not supported');
    } else if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      const name = source.slice(i + 2, end).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`mismatched closing tag </${name}> for <${node?.name}>`);
      top().children.push(node);
      i = end + 1;
    } else if (source[i] === '<') {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(i, i + 256));
      if (!m) throw new Error(`malformed tag at ${i}`);
      let j = i + m[0].length;
      const attrs = {};
      for (;;) {
        while (/\s/.test(source[j] ?? '')) j++;
        if (source.startsWith('/>', j)) {
          top().children.push({ name: m[1], attrs, children: [], text: '' });
          j += 2;
          break;
        }
        if (source[j] === '>') {
          stack.push({ name: m[1], attrs, children: [], text: '' });
          j += 1;
          break;
        }
        const a = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(j, j + 1_000_000));
        if (!a) throw new Error(`malformed attribute in <${m[1]}> at ${j}`);
        attrs[a[1]] = decode(a[3] ?? a[4]);
        j += a[0].length;
      }
      i = j;
    } else {
      const end = source.indexOf('<', i);
      const text = source.slice(i, end < 0 ? source.length : end);
      top().text += decode(text);
      i = end < 0 ? source.length : end;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${top().name}>`);
  const roots = stack[0].children;
  if (roots.length !== 1) throw new Error(`expected one root element, found ${roots.length}`);
  return roots[0];
}

// ------------------------------------------------------ classification ----

/** The exception class a failure reports, from its type or its text. */
function exceptionClass({ type = '', message = '', details = '' }) {
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(type) || /(Error|Exception|Failure)$/.test(type)) return type;
  const text = `${details}\n${message}`;
  const cause = /cause: ([A-Za-z_$][\w$.]*(?:Error|Exception|Failure))\b/.exec(text);
  if (cause) return cause[1];
  const first = /(?:^|\n)\s*(?:\[?Error \[ERR_TEST_FAILURE\]: )?([A-Za-z_$][\w$.]*(?:Error|Exception|Failure))\b/.exec(text);
  return first ? first[1] : null;
}

/**
 * Classify one test failure. `{ type, message, details }` come from the
 * report (`type` is an exception class where the runner gives one).
 */
export function classifyFailure(failure) {
  const { message = '', details = '' } = failure;
  const cls = exceptionClass(failure) ?? '';
  const simple = cls.split('.').pop();
  const text = `${cls}\n${message}\n${details}`;
  if (/\b(test|hook) timed out\b|\btimed out after\b|\bTimeoutException\b|\bexecution timed out\b|\bexceeded timeout\b/i.test(text)) return 'timeout';
  if (/^(OutOfMemoryError|StackOverflowError|InternalError|VirtualMachineError)$/.test(simple)) return 'crash';
  if (simple === 'SyntaxError' || /\bTransform failed\b|\bERR_INVALID_TYPESCRIPT_SYNTAX\b|\bUnexpected token\b/.test(text)) return 'syntax';
  if (/^(ClassNotFoundException|NoClassDefFoundError)$/.test(simple) || /\bERR_MODULE_NOT_FOUND\b|Cannot find (module|package)\b|Failed to (resolve|load) (import|url)\b/.test(text)) return 'import';
  if (/^(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError|LinkageError)$/.test(simple)) return 'missing-symbol';
  if (simple === 'TypeError' && /\bis not a (function|constructor)\b|\bdoes not provide an export named\b/.test(text)) return 'missing-symbol';
  if (/does not provide an export named/.test(text)) return 'missing-symbol';
  if (/Failed to load ApplicationContext|^(BeanCreationException|UnsatisfiedDependencyException|ApplicationContextException|ExceptionInInitializerError)$|\b(before|after)(All| all)\b hook/.test(`${simple}\n${message}\n${details}`)) {
    return 'setup';
  }
  if (/^(AssertionError|AssertionFailedError|ComparisonFailure|MultipleFailuresError|AssertionFailure|ExpectationNotMetError)$/.test(simple) || /\bERR_ASSERTION\b/.test(text)) return 'assertion';
  return 'exception';
}

/** Collapse volatile detail so the same failure hashes the same on every run. */
export function normaliseFailureText(text) {
  return String(text)
    .split(/\r?\n/)
    .find((l) => l.trim() !== '')
    ?.replace(/[A-Za-z]:[\\/][^\s:)'"]+/g, '<path>')
    .replace(/(?:\/[\w.@-]+)+(?:\.[A-Za-z0-9]+)?/g, '<path>')
    .replace(/0x[0-9a-fA-F]+/g, '<hex>')
    .replace(/\b[0-9a-f]{7,64}\b/g, '<id>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|minutes)\b/gi, '<dur>')
    .replace(/:\d+(:\d+)?/g, ':<n>')
    .replace(/@[0-9a-f]{4,}/g, '@<id>')
    .replace(/\s+/g, ' ')
    .trim() ?? '';
}

export function failureFingerprint({ category, type, message }) {
  return sha256Hex(canonicalJson({ category, type: type ?? null, message: normaliseFailureText(message ?? '') })).slice(0, 16);
}

function finish(result) {
  result.id = `${result.file}::${result.suite ? `${result.suite} > ` : ''}${result.name}`;
  result.fingerprint = result.status === 'failed' ? failureFingerprint(result) : null;
  return result;
}

function repoRelative(root, file) {
  if (!file) return null;
  const rel = isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? relative(root, file) : file;
  return rel.split('\\').join('/');
}

// ---------------------------------------------------------------- JUnit ----

/**
 * Parse a JUnit XML report (Node's reporter or Surefire). With `moduleDir`
 * (Surefire), a test class maps to `<moduleDir>/src/test/java/<class>.java`
 * and the id is `<moduleDir>/<class>#<method>`.
 */
export function parseJUnit(xml, { root = '', moduleDir = null } = {}) {
  const doc = parseXml(xml);
  const results = [];
  const visit = (node, suites) => {
    if (node.name === 'testsuites') {
      for (const c of node.children) visit(c, suites);
      return;
    }
    if (node.name === 'testsuite') {
      const nested = moduleDir === null && node.attrs.name ? [...suites, node.attrs.name] : suites;
      for (const c of node.children) visit(c, nested);
      return;
    }
    if (node.name !== 'testcase') return;
    const failure = node.children.find((c) => c.name === 'failure' || c.name === 'error');
    const skipped = node.children.find((c) => c.name === 'skipped');
    const r = { file: null, suite: suites.join(' > '), name: node.attrs.name ?? '', status: 'passed', category: 'passed', type: null, message: null };
    if (moduleDir !== null) {
      const cls = node.attrs.classname ?? '';
      r.file = `${moduleDir}/src/test/java/${cls.split('$')[0].replaceAll('.', '/')}.java`;
      r.suite = '';
    } else {
      r.file = repoRelative(root, node.attrs.file);
    }
    if (failure) {
      r.status = 'failed';
      r.type = failure.attrs.type && failure.attrs.type !== 'testCodeFailure' ? failure.attrs.type : null;
      r.message = failure.attrs.message ?? '';
      r.category = classifyFailure({ type: r.type ?? '', message: r.message, details: failure.text });
      if (r.type === null) r.type = exceptionClass({ message: r.message, details: failure.text });
    } else if (skipped) {
      r.status = 'skipped';
      r.category = 'skipped';
    }
    const result = finish(r);
    if (moduleDir !== null) result.id = `${moduleDir}/${node.attrs.classname}#${r.name}`;
    results.push(result);
  };
  visit(doc, []);
  return results;
}

// --------------------------------------------------------------- Vitest ----

/** Parse Vitest's `--reporter=json` output (object or JSON text). */
export function parseVitestJson(report, { root = '' } = {}) {
  const data = typeof report === 'string' ? JSON.parse(report) : report;
  const results = [];
  for (const file of data.testResults ?? []) {
    const rel = repoRelative(root, file.name);
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.status === 'failed') {
      const r = { file: rel, suite: '', name: '<suite>', status: 'failed', type: null, message: file.message ?? '' };
      r.category = classifyFailure({ details: r.message });
      if (r.category === 'assertion' || r.category === 'exception') r.category = 'setup';
      r.type = exceptionClass({ details: r.message });
      results.push(finish(r));
      continue;
    }
    for (const a of assertions) {
      const r = { file: rel, suite: (a.ancestorTitles ?? []).join(' > '), name: a.title, status: 'passed', category: 'passed', type: null, message: null };
      if (a.status === 'failed') {
        const details = (a.failureMessages ?? []).join('\n');
        r.status = 'failed';
        r.message = details.split('\n')[0];
        r.type = exceptionClass({ details });
        r.category = classifyFailure({ details });
      } else if (a.status !== 'passed') {
        r.status = 'skipped';
        r.category = 'skipped';
      }
      results.push(finish(r));
    }
  }
  return results;
}
