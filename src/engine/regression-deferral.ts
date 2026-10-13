/**
 * A producer's full-suite regression that fails only where its dependents
 * will re-verify.
 *
 * With module-scoped gates (engine/modules.ts) a producer proves its own
 * module RED and GREEN, and its regression runs the repository's whole
 * suite. There a dependent's test that pins the producer's old behaviour can
 * fail until the dependent's own node adapts — CSET-202's cli tests after an
 * errors change, for one. Blaming the producer would block the only node
 * that can move the feature forward. When every failing test file lies in
 * the fence of a dependent of this node (it reopens and re-verifies after
 * this one), the failure is that dependency's expected invalidation: the
 * regression is recorded as deferred to those dependents, a DONE one is
 * reopened, each of them later runs the whole suite itself, and the
 * candidate and delivery acceptance still require it. Anything else — a
 * failure in the producer's own fence, in a file no dependent owns, a run
 * that crashed, did not compile or timed out, output that cannot be read
 * completely — is the producer's own regression.
 */
import type { FeatureState_, GraphNode, PortfolioGraph } from '../model/types.js';
import { isAbsolute, resolve } from 'node:path';
import { matchGlob } from '../git/worktree.js';
import { runGit } from '../git/git.js';
import { nodeTapFailures, repoRelative } from '../evidence/red-classify.js';

export interface FailingTests {
  /** True only when the runner's own counts agree with what was read. */
  complete: boolean;
  /** Repository-relative test files, `/`-separated, sorted. */
  files: string[];
  /** Fully qualified test classes (Surefire), sorted. */
  classes: string[];
}

const slash = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

/**
 * The test files (or classes) a full-suite run failed in, from the runner's own output. Node 22's TAP names each
 * failing test's file absolute: `root` (the checkout the suite ran in) makes it repository-relative, and without it
 * nothing is read from TAP.
 */
export function failingTestFiles(output: string, exitCode: number, root?: string): FailingTests {
  const none: FailingTests = { complete: false, files: [], classes: [] };
  if (exitCode === 0 || exitCode === 124 || /\[mycelink\] (command|step) timed out/.test(output)) return none;
  if (/\bCOMPILATION ERROR\b|\bCompilation failure\b|\bTransform failed\b/.test(output)) return none;

  // Vitest: " FAIL  <file> > ..." and " FAIL  <file> [ <file> ]", checked against "Test Files  N failed".
  const vitestFiles = uniq([...output.matchAll(/^\s*FAIL\s+(\S+?)(?:\s+>|\s+\[|\s*$)/gm)].map((m) => slash(m[1] as string)));
  const vitestCount = /^\s*Test Files\s+(\d+) failed\b/m.exec(output);
  if (vitestCount !== null) {
    return vitestFiles.length > 0 && Number(vitestCount[1]) === vitestFiles.length ? { complete: true, files: vitestFiles, classes: [] } : none;
  }

  // Node's TAP (Node 22's default into a pipe): each failing test's `location:`, checked against "# fail N"; a suite
  // that failed through a subtest is no failure of its own, and `# fail` does not count it.
  const tapFail = /^# fail (\d+)\s*$/m.exec(output);
  const tap = nodeTapFailures(output).filter((f) => f.failureType !== null);
  if (tapFail !== null && tap.length > 0) {
    const failures = tap.filter((f) => !f.suite);
    if (root === undefined || failures.length === 0 || failures.length !== Number(tapFail[1])) return none;
    const files: string[] = [];
    for (const f of failures) {
      const at = f.location === null ? null : (/^(.*):\d+:\d+$/.exec(f.location)?.[1] ?? null);
      const rel = at === null ? null : repoRelative(root, isAbsolute(at) || /^[A-Za-z]:[\\/]/.test(at) ? at : resolve(root, at));
      if (rel === null || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return none;
      files.push(slash(rel));
    }
    return { complete: true, files: uniq(files), classes: [] };
  }

  // Node's runner: "test at <file>:<line>:<col>" per failing test, checked against "ℹ fail N".
  const nodeAt = [...output.matchAll(/^test at (.+?):\d+:\d+\s*$/gm)].map((m) => slash(m[1] as string));
  const nodeFail = /^\S*\s*fail (\d+)\s*$/m.exec(output);
  if (nodeFail !== null) {
    return nodeAt.length > 0 && Number(nodeFail[1]) === nodeAt.length ? { complete: true, files: uniq(nodeAt), classes: [] } : none;
  }

  // Surefire: "Tests run: ..., <<< FAILURE! -- in <class>"; the build must have failed on test failures only.
  const classes = uniq([...output.matchAll(/<<< (?:FAILURE|ERROR)!\s+-+\s+in\s+([A-Za-z_$][\w$.]*)/g)].map((m) => m[1] as string));
  if (classes.length > 0) {
    const goals = [...output.matchAll(/\[ERROR\] Failed to execute goal [^\n]*/g)].map((m) => m[0]);
    return goals.every((g) => /There (are|were) test failures/.test(g)) ? { complete: true, files: [], classes } : none;
  }
  return none;
}

/** Every node that depends, directly or not, on `nodeId`. */
function dependentsOf(graph: PortfolioGraph, nodeId: string): GraphNode[] {
  const reach = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const n of graph.nodes) {
      if (n.depends_on.includes(current) && !reach.has(n.id)) {
        reach.add(n.id);
        queue.push(n.id);
      }
    }
  }
  return graph.nodes.filter((n) => reach.has(n.id));
}

const owns = (n: GraphNode, file: string): boolean => n.allowed_paths.some((g) => matchGlob(g, file)) && !(n.forbidden_paths ?? []).some((g) => matchGlob(g, file));

export interface DeferralArgs {
  graph: PortfolioGraph;
  state: FeatureState_;
  nodeId: string;
  output: string;
  exitCode: number;
  /** The checkout the suite ran in: Surefire classes are found among its test sources. */
  checkout: string;
}

export type DeferralDecision = { deferred: true; to: string[]; failing: string[] } | { deferred: false; reason: string };

/** Whether a failed full-suite regression of `nodeId` is the expected invalidation of its dependents, and to whom it passes. */
export function regressionDeferral(args: DeferralArgs): DeferralDecision {
  const node = args.graph.nodes.find((n) => n.id === args.nodeId);
  if (node === undefined || node.repository === null) return { deferred: false, reason: 'the node has no repository' };
  const failing = failingTestFiles(args.output, args.exitCode, args.checkout);
  if (!failing.complete) return { deferred: false, reason: 'the run did not show which test files failed (a crash, a compile error, a timeout, or counts that do not agree)' };
  let files = failing.files;
  if (failing.classes.length > 0) {
    const sources = runGit(args.checkout, ['ls-files', '-z'], { allowFail: true }).stdout.split('\0').filter((p) => p !== '');
    const mapped: string[] = [];
    for (const cls of failing.classes) {
      const suffix = `src/test/java/${cls.split('$')[0]?.replace(/\./g, '/')}.java`;
      const hit = sources.filter((p) => p === suffix || p.endsWith(`/${suffix}`));
      if (hit.length !== 1) return { deferred: false, reason: `the failing class ${cls} is not exactly one test source of the checkout` };
      mapped.push(hit[0] as string);
    }
    files = uniq([...files, ...mapped]);
  }
  const own = files.filter((f) => owns(node, f));
  if (own.length > 0) return { deferred: false, reason: `${own.join(', ')} ${own.length === 1 ? 'is' : 'are'} in this node's own fence` };
  const dependents = dependentsOf(args.graph, args.nodeId).filter((n) => n.repository === node.repository);
  const to = new Set<string>();
  const orphan: string[] = [];
  for (const file of files) {
    const owners = dependents.filter((n) => owns(n, file));
    if (owners.length === 0) orphan.push(file);
    for (const o of owners) to.add(o.id);
  }
  if (orphan.length > 0) return { deferred: false, reason: `${orphan.join(', ')} ${orphan.length === 1 ? 'is' : 'are'} in no module a dependent of this node owns` };
  const order = args.graph.nodes.map((n) => n.id);
  return { deferred: true, to: [...to].sort((a, b) => order.indexOf(a) - order.indexOf(b)), failing: files.slice(0, 64) };
}
