/**
 * What a RED proves.
 *
 * A RED is evidence that a behaviour is missing only when the tests it
 * declares fail an assertion, or with an exception from the code under test.
 * A syntax, import or missing-symbol failure, a setup step that failed, a
 * declared test that never ran, no declared test at all, a timeout, a crash
 * or a pass prove nothing; a nonzero exit alone is never enough.
 *
 * In CSET-202 r1 core accepted the errors node's RED (`TypeError:
 * ChangesetValidationError is not a constructor`: its test statically used
 * a class that did not exist yet) as a missing behaviour, settled it, and
 * the independent replay rejected the delivery for exactly that. The
 * classification here is the replay's (evals-public-projects lib/results.mjs
 * and lib/tdd.mjs), kept in parity by tests/benchmark/red-parity.test.ts:
 *
 *  - structured reports (Vitest JSON, JUnit XML from Surefire or Node's
 *    reporter) are read into one result per test and each failure is
 *    classified from its exception type and text;
 *  - a RED is judged on the tests its delta declares: any of them that did
 *    not run or failed for a reason that proves nothing makes it invalid, at
 *    least one must fail for a missing behaviour;
 *  - without a report, conservative patterns over the output decide, and
 *    anything that cannot be shown to be an assertion or a code-under-test
 *    exception is invalid.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';

export type FailureCategory = 'assertion' | 'exception' | 'syntax' | 'import' | 'missing-symbol' | 'setup' | 'timeout' | 'crash';

/** Categories a RED can end in: a test's failure category, or why the run as a whole proves nothing. */
export type RedCategory = FailureCategory | 'not-run' | 'no-test' | 'passed' | 'compile' | 'environment';

export const RED_VALID_CATEGORIES: ReadonlySet<string> = new Set(['assertion', 'exception']);

/** The replay's invalid categories, and core's own stricter ones (a compile error, an unreachable environment, no declared test, a pass). */
export const INVALID_RED_CATEGORIES: ReadonlySet<string> = new Set([
  'syntax',
  'import',
  'missing-symbol',
  'setup',
  'timeout',
  'crash',
  'not-run',
  'no-test',
  'passed',
  'compile',
  'environment',
]);

export interface TestResult {
  id: string;
  /** Repository-relative, `/`-separated. */
  file: string | null;
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  category: string;
  type: string | null;
  message: string | null;
  fingerprint: string | null;
  /** Surefire: the testcase's binary class name (`pkg.Outer$Inner`), as reported — raw evidence of its identity (evidence/test-identity.ts). */
  classname?: string;
}

// ---- hashing -------------------------------------------------------------------

/** The replay's canonical JSON: sorted keys, strings by JSON.stringify. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---- XML -----------------------------------------------------------------------

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ent: string) => {
    if (ent.startsWith('#')) return String.fromCodePoint(ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10));
    return ENTITIES[ent] ?? whole;
  });
}

/** A small, strict XML parser for test reports: elements, attributes, entities, CDATA, comments. No DTDs. */
export function parseXml(source: string): XmlNode {
  let i = 0;
  const stack: XmlNode[] = [{ name: '#document', attrs: {}, children: [], text: '' }];
  const top = (): XmlNode => stack[stack.length - 1] as XmlNode;
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
      const attrs: Record<string, string> = {};
      for (;;) {
        while (/\s/.test(source[j] ?? '')) j++;
        if (source.startsWith('/>', j)) {
          top().children.push({ name: m[1] as string, attrs, children: [], text: '' });
          j += 2;
          break;
        }
        if (source[j] === '>') {
          stack.push({ name: m[1] as string, attrs, children: [], text: '' });
          j += 1;
          break;
        }
        const a = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(j, j + 1_000_000));
        if (!a) throw new Error(`malformed attribute in <${m[1]}> at ${j}`);
        attrs[a[1] as string] = decode((a[3] ?? a[4]) as string);
        j += a[0].length;
      }
      i = j;
    } else {
      const end = source.indexOf('<', i);
      top().text += decode(source.slice(i, end < 0 ? source.length : end));
      i = end < 0 ? source.length : end;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed element <${top().name}>`);
  const roots = (stack[0] as XmlNode).children;
  if (roots.length !== 1) throw new Error(`expected one root element, found ${roots.length}`);
  return roots[0] as XmlNode;
}

// ---- classification ------------------------------------------------------------

interface Failure {
  type?: string;
  message?: string;
  details?: string;
}

/** The exception class a failure reports, from its type or its text. */
export function exceptionClass({ type = '', message = '', details = '' }: Failure): string | null {
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(type) || /(Error|Exception|Failure)$/.test(type)) return type;
  const text = `${details}\n${message}`;
  const cause = /cause: ([A-Za-z_$][\w$.]*(?:Error|Exception|Failure))\b/.exec(text);
  if (cause) return cause[1] as string;
  const first = /(?:^|\n)\s*(?:\[?Error \[ERR_TEST_FAILURE\]: )?([A-Za-z_$][\w$.]*(?:Error|Exception|Failure))\b/.exec(text);
  return first ? (first[1] as string) : null;
}

/** Classify one test failure from its exception type and text, as the replay does. */
export function classifyFailure(failure: Failure): FailureCategory {
  const { message = '', details = '' } = failure;
  const cls = exceptionClass(failure) ?? '';
  const simple = cls.split('.').pop() ?? '';
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
export function normaliseFailureText(text: string): string {
  return (
    String(text)
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
      .trim() ?? ''
  );
}

/** A test failure's identity: its category, exception type and normalised first message line. */
export function testFailureFingerprint({ category, type, message }: { category: string; type: string | null; message: string | null }): string {
  return sha256Hex(canonicalJson({ category, type: type ?? null, message: normaliseFailureText(message ?? '') })).slice(0, 16);
}

interface PartialResult {
  file: string | null;
  suite: string;
  name: string;
  status: TestResult['status'];
  category: string;
  type: string | null;
  message: string | null;
}

function finish(r: PartialResult): TestResult {
  return {
    id: `${r.file}::${r.suite ? `${r.suite} > ` : ''}${r.name}`,
    ...r,
    fingerprint: r.status === 'failed' ? testFailureFingerprint(r) : null,
  };
}

function repoRelative(root: string, file: string | undefined | null): string | null {
  if (!file) return null;
  const rel = isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? relative(root, file) : file;
  return rel.split('\\').join('/');
}

// ---- reports -------------------------------------------------------------------

/**
 * A JUnit XML report (Node's reporter or Surefire). With `moduleDir`
 * (Surefire), a test class maps to `<moduleDir>/src/test/java/<class>.java`
 * and the id is `<moduleDir>/<class>#<method>`.
 */
export function parseJUnit(xml: string, { root = '', moduleDir = null }: { root?: string; moduleDir?: string | null } = {}): TestResult[] {
  const doc = parseXml(xml);
  const results: TestResult[] = [];
  const visit = (node: XmlNode, suites: string[]): void => {
    if (node.name === 'testsuites') {
      for (const c of node.children) visit(c, suites);
      return;
    }
    if (node.name === 'testsuite') {
      const nested = moduleDir === null && node.attrs['name'] ? [...suites, node.attrs['name']] : suites;
      for (const c of node.children) visit(c, nested);
      return;
    }
    if (node.name !== 'testcase') return;
    const failure = node.children.find((c) => c.name === 'failure' || c.name === 'error');
    const skipped = node.children.find((c) => c.name === 'skipped');
    const r: PartialResult = { file: null, suite: suites.join(' > '), name: node.attrs['name'] ?? '', status: 'passed', category: 'passed', type: null, message: null };
    if (moduleDir !== null) {
      const cls = node.attrs['classname'] ?? '';
      r.file = `${moduleDir}/src/test/java/${(cls.split('$')[0] ?? '').replaceAll('.', '/')}.java`;
      r.suite = '';
    } else {
      r.file = repoRelative(root, node.attrs['file']);
    }
    if (failure) {
      r.status = 'failed';
      const ftype = failure.attrs['type'];
      r.type = ftype && ftype !== 'testCodeFailure' ? ftype : null;
      r.message = failure.attrs['message'] ?? '';
      r.category = classifyFailure({ type: r.type ?? '', message: r.message, details: failure.text });
      if (r.type === null) r.type = exceptionClass({ message: r.message, details: failure.text });
    } else if (skipped) {
      r.status = 'skipped';
      r.category = 'skipped';
    }
    const result = finish(r);
    if (moduleDir !== null) {
      result.id = `${moduleDir}/${node.attrs['classname']}#${r.name}`;
      result.classname = node.attrs['classname'] ?? '';
    }
    results.push(result);
  };
  visit(doc, []);
  return results;
}

interface VitestReport {
  testResults?: {
    name: string;
    status?: string;
    message?: string;
    assertionResults?: { ancestorTitles?: string[]; title: string; status: string; failureMessages?: string[] }[];
  }[];
}

/** Vitest's `--reporter=json` output (object or JSON text). A suite that failed to load is one `<suite>` result of its file. */
export function parseVitestJson(report: string | VitestReport, { root = '' }: { root?: string } = {}): TestResult[] {
  const data = (typeof report === 'string' ? JSON.parse(report) : report) as VitestReport;
  const results: TestResult[] = [];
  for (const file of data.testResults ?? []) {
    const rel = repoRelative(root, file.name);
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.status === 'failed') {
      const message = file.message ?? '';
      let category: string = classifyFailure({ details: message });
      if (category === 'assertion' || category === 'exception') category = 'setup';
      results.push(finish({ file: rel, suite: '', name: '<suite>', status: 'failed', category, type: exceptionClass({ details: message }), message }));
      continue;
    }
    for (const a of assertions) {
      const r: PartialResult = { file: rel, suite: (a.ancestorTitles ?? []).join(' > '), name: a.title, status: 'passed', category: 'passed', type: null, message: null };
      if (a.status === 'failed') {
        const details = (a.failureMessages ?? []).join('\n');
        r.status = 'failed';
        r.message = details.split('\n')[0] ?? '';
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

// ---- output without a report -----------------------------------------------------

/** A line that shows some test failed, in the common runners' own words. */
const FAILING_TEST = [
  /^\s*(FAIL|×|✗|✕|✖)\s/m,
  /\bnot ok \d+/,
  /\b\d+ failing\b/,
  /\bTests run: \d+, Failures: \d+, Errors: \d+.*<<< (FAILURE|ERROR)!/,
  /<<< (FAILURE|ERROR)!/,
  /^--- FAIL:/m,
  /^FAILED /m,
  /=+ \d+ failed/,
  /\bTests?:?\s+\d+ failed\b/,
  /\bTest Files\s+\d+ failed\b/,
];

const PATTERNS: { category: RedCategory; patterns: RegExp[] }[] = [
  { category: 'syntax', patterns: [/\bSyntaxError\b/, /\bTransform failed\b/, /\bERR_INVALID_TYPESCRIPT_SYNTAX\b/, /\bUnexpected token\b/, /\bunexpected end of input\b/i, /\bTS1\d{3}\b/, /\bparse error\b/i] },
  { category: 'compile', patterns: [/\bCOMPILATION ERROR\b/, /\bCompilation failure\b/, /\bcannot find symbol\b/, /\berror TS2\d{3}\b/, /\bcompilation failed\b/i] },
  { category: 'import', patterns: [/\bClassNotFoundException\b/, /\bNoClassDefFoundError\b/, /\bERR_MODULE_NOT_FOUND\b/, /Cannot find (module|package)\b/, /Failed to (resolve|load) (import|url)\b/, /\bModuleNotFoundError\b/, /\bImportError\b/] },
  {
    category: 'missing-symbol',
    patterns: [/\b(NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError|LinkageError)\b/, /\bTypeError\b[^\n]*\bis not a (function|constructor)\b/, /does not provide an export named/, /\bis not exported by\b/, /\bReferenceError\b[^\n]*\bis not defined\b/],
  },
  {
    category: 'setup',
    patterns: [/Failed to load ApplicationContext/, /\b(BeanCreationException|UnsatisfiedDependencyException|ApplicationContextException|ExceptionInInitializerError)\b/, /\b(before|after)(All| all)\b hook/, /\bmissing script\b/, /\bcommand not found\b/, /is not recognized as an internal or external command/],
  },
  { category: 'no-test', patterns: [/\bNo test files found\b/, /\bNo tests found\b/i, /\bno tests to run\b/i, /\bNo tests were executed\b/, /\bTests run: 0, Failures: 0\b/] },
  { category: 'environment', patterns: [/\bECONNREFUSED\b/, /\bENOTFOUND\b/, /\bETIMEDOUT\b/, /\bEHOSTUNREACH\b/, /\bEADDRINUSE\b/, /\baddress already in use\b/i, /\bconnection refused\b/i, /\bEACCES\b/, /\bEPERM\b/, /\bno space left\b/i] },
];

const ASSERTION = [
  /\bAssertionError\b/,
  /\bAssertionFailedError\b/,
  /\bComparisonFailure\b/,
  /\bMultipleFailuresError\b/,
  /\bExpectationNotMetError\b/,
  /\bERR_ASSERTION\b/,
  /\bexpected\b[^\n]*\bto\b/i,
  /\bexpected:\s*<[^\n]*>\s*but was:\s*</i,
  /^\s*Expected[:\s][\s\S]*^\s*Received[:\s]/m,
  /\bnot ok \d+/,
  /\b\d+ failing\b/,
  /\bassert(ion)? failed\b/i,
];

/**
 * The category of a RED's output when no structured report exists:
 * conservative patterns, invalid ones first (a run that shows any of them
 * proves nothing), then an assertion, then an exception thrown inside a
 * test the runner reports as failing. Anything else is a crash: invalid.
 */
export function classifyRedOutput(output: string, exitCode: number, options: { timedOut?: boolean } = {}): { category: RedCategory; evidence: string | null } {
  if (options.timedOut === true) return { category: 'timeout', evidence: null };
  if (exitCode === 0) return { category: 'passed', evidence: null };
  const lines = output.split(/\r?\n/);
  const lineOf = (rx: RegExp): string | null => {
    const at = output.search(rx);
    if (at < 0) return null;
    const start = output.lastIndexOf('\n', at) + 1;
    const end = output.indexOf('\n', at);
    return output.slice(start, end < 0 ? output.length : end).trim().slice(0, 300);
  };
  for (const { category, patterns } of PATTERNS) {
    const hit = patterns.find((rx) => rx.test(output));
    if (hit) return { category, evidence: lineOf(hit) };
  }
  const assertion = ASSERTION.find((rx) => rx.test(output));
  if (assertion) return { category: 'assertion', evidence: lineOf(assertion) };
  const failing = FAILING_TEST.find((rx) => rx.test(output));
  if (failing) {
    const thrown = lines.find((l) => /^\s*(?:[A-Za-z_$][\w$]*\.)*(?:[A-Za-z_$][\w$]*)?(?:Error|Exception)\b(?::|\s|$)/.test(l));
    if (thrown !== undefined) return { category: 'exception', evidence: thrown.trim().slice(0, 300) };
  }
  return { category: 'crash', evidence: null };
}

/** What a worker whose RED was refused does next: the same words in the gate's refusal and in every worker brief. */
export const RED_RETRY_GUIDANCE =
  'A RED test must compile and fail an assertion or the expected domain behaviour. For a new export or type, inspect the module dynamically ' +
  '(import its namespace and assert the export exists and behaves) or drive the behaviour through an existing entry point; never statically ' +
  'import or call a symbol that does not exist yet. Change the test, not production code, and run red again.';

/** The coarse reason a RED evidence record carries; only `behaviour-missing` is valid. */
export function redReasonFor(category: RedCategory): 'behaviour-missing' | 'setup-error' | 'syntax-error' | 'environment-error' {
  if (RED_VALID_CATEGORIES.has(category)) return 'behaviour-missing';
  if (category === 'syntax' || category === 'compile') return 'syntax-error';
  if (category === 'environment') return 'environment-error';
  return 'setup-error';
}

// ---- the RED as a whole --------------------------------------------------------

export interface DeclaredTest {
  file: string;
  name: string;
}

export interface RedTestOutcome {
  file: string;
  name: string;
  status: TestResult['status'] | 'not-run';
  category: string;
  type: string | null;
  fingerprint: string | null;
}

export interface RedJudgement {
  valid: boolean;
  category: RedCategory;
  /** One line a worker can act on. */
  detail: string;
  /** Identity of the deciding failure, stable across runs. */
  fingerprint: string;
  /** The declared tests and how each ended (structured reports only). */
  tests: RedTestOutcome[];
}

export interface JudgeRedArgs {
  exitCode: number;
  timedOut: boolean;
  output: string;
  /** Results of a structured report, or null when the command has none. */
  results: TestResult[] | null;
  /** Tests the RED's delta adds or changes; null when they cannot be read. */
  declared: DeclaredTest[] | null;
  /** A setup or build step before the test command that did not succeed. */
  failedStep?: { argv: string[]; exit_code: number } | null;
}

/** Parameterised and repeated tests report as `name(args)[n]`. */
function matches(result: TestResult, expected: DeclaredTest): boolean {
  return result.file === expected.file && (result.name === expected.name || result.name.startsWith(`${expected.name}(`) || result.name.startsWith(`${expected.name}[`));
}

/**
 * One outcome per declared test: any failure fails it, else any pass passes
 * it; a test no result names did not run.
 */
export function summarizeDeclared(results: readonly TestResult[], declared: readonly DeclaredTest[]): RedTestOutcome[] {
  return declared.map((e) => {
    const matching = results.filter((r) => matches(r, e));
    const r = matching.find((x) => x.status === 'failed') ?? matching.find((x) => x.status === 'passed') ?? matching[0];
    return r
      ? { file: e.file, name: e.name, status: r.status, category: r.category, type: r.type, fingerprint: r.fingerprint }
      : { file: e.file, name: e.name, status: 'not-run' as const, category: 'not-run', type: null, fingerprint: null };
  });
}

const PRIORITY: readonly string[] = ['syntax', 'compile', 'import', 'missing-symbol', 'setup', 'environment', 'timeout', 'crash', 'not-run'];

function judgement(valid: boolean, category: RedCategory, detail: string, basis: unknown, tests: RedTestOutcome[] = []): RedJudgement {
  return { valid, category, detail: detail.slice(0, 600), fingerprint: sha256Hex(canonicalJson({ category, basis })).slice(0, 16), tests };
}

/**
 * Judge a RED run as the replay judges a unit's RED: on the declared tests
 * when a structured report exists, else on the conservative output
 * patterns. Never valid on a nonzero exit alone.
 */
export function judgeRed(args: JudgeRedArgs): RedJudgement {
  if (args.failedStep) {
    return judgement(false, 'setup', `the step ${args.failedStep.argv.join(' ')} exited ${args.failedStep.exit_code} before the tests ran`, args.failedStep.argv);
  }
  if (args.timedOut) return judgement(false, 'timeout', 'the RED run timed out', 'timeout');
  if (args.declared !== null && args.declared.length === 0) {
    return judgement(false, 'no-test', 'the RED declares no new or changed test: write the failing test first', 'no-test');
  }
  if (args.results !== null && args.declared !== null) {
    const tests = summarizeDeclared(args.results, args.declared);
    // As the replay: a declared test that passes (an unchanged test of a file whose imports changed) is no wrong
    // reason; the RED still needs a declared test failing for a missing behaviour, and none failing for another.
    const invalid = tests.filter((t) => t.status === 'not-run' || (t.status === 'failed' && INVALID_RED_CATEGORIES.has(t.category)));
    if (invalid.length > 0) {
      const worst = [...invalid].sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category))[0] as RedTestOutcome;
      // The replay's own wording (lib/tdd.mjs), so a worker reads the same reason in both.
      const detail = `RED failed for the wrong reason: ${invalid.map((t) => `${t.name} (${t.category})`).join(', ')}`;
      return judgement(false, worst.category as RedCategory, detail, invalid.map((t) => [t.file, t.name, t.category, t.fingerprint]), tests);
    }
    const failing = tests.filter((t) => t.status === 'failed');
    if (args.exitCode === 0 || failing.length === 0) {
      return judgement(false, 'passed', 'the RED does not fail: its declared tests pass', 'passed', tests);
    }
    const valid = failing.filter((t) => RED_VALID_CATEGORIES.has(t.category));
    if (valid.length === 0) return judgement(false, 'crash', 'no declared test fails for a missing behaviour', failing.map((t) => t.category), tests);
    const category = (valid.find((t) => t.category === 'assertion') ?? valid[0] as RedTestOutcome).category as RedCategory;
    return judgement(true, category, `${valid.map((t) => t.name).join(', ')} failed for a missing behaviour (${category})`, valid.map((t) => [t.file, t.name, t.fingerprint]), tests);
  }
  const text = classifyRedOutput(args.output, args.exitCode, { timedOut: args.timedOut });
  const valid = RED_VALID_CATEGORIES.has(text.category);
  const detail = valid
    ? `the output shows a ${text.category}${text.evidence ? `: ${text.evidence}` : ''}`
    : text.category === 'passed'
      ? 'the RED does not fail'
      : `RED failed for the wrong reason (${text.category})${text.evidence ? `: ${text.evidence}` : ''}`;
  return judgement(valid, text.category, detail, text.evidence === null ? text.category : normaliseFailureText(text.evidence));
}
