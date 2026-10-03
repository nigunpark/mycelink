/**
 * ECC PRD / Plan adapter.
 *
 * Converts the Markdown artifacts an ECC `/plan-prd` and `/plan` run produces
 * into the portfolio graph compiler's input, **without** weakening the
 * approval gate: an unapproved PRD or plan is refused outright, and the
 * result is always a *draft* that a human still reviews before it can run.
 *
 * The parser is deliberately tolerant about formatting and strict about
 * substance. It never invents a repository, a command or a node: anything
 * missing is reported as a problem for a person to resolve.
 *
 * Validated against the documented PRD/Plan shape only, not against output
 * from a live ECC installation. See docs/ADAPTERS.md.
 */
import YAML from 'yaml';
import type { EvidenceKind, PortfolioGraph, Problem, RepositoryManifest } from '../model/types.js';

export class EccApprovalError extends Error {
  constructor(artifact: string, status: string) {
    super(
      `${artifact} has status "${status}", not APPROVED. ` +
        `The approval gate is the point: fix the artifact and have it approved, do not bypass this.`,
    );
    this.name = 'EccApprovalError';
  }
}

export interface EccPrd {
  feature_id: string;
  title: string;
  acceptance_criteria: { id: string; text: string }[];
}

export interface EccBehaviour {
  id: string;
  title: string;
  repository: string | null;
  capability: string | null;
  acceptance_criteria: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  depends_on: string[];
  contract_inputs: string[];
  contract_outputs: string[];
  required_resources: string[];
  required_evidence: EvidenceKind[];
  red_target: string[] | null;
  green_target: string[] | null;
  regression: string[] | null;
}

export interface EccPlan {
  feature_id: string;
  behaviours: EccBehaviour[];
  problems: Problem[];
}

interface Frontmatter {
  body: string;
  data: Record<string, unknown>;
}

function splitFrontmatter(markdown: string): Frontmatter {
  const text = markdown.replace(/^﻿/, '');
  if (!text.startsWith('---')) return { body: text, data: {} };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { body: text, data: {} };
  const data = (YAML.parse(text.slice(3, end)) ?? {}) as Record<string, unknown>;
  return { body: text.slice(end + 4).replace(/^\r?\n/, ''), data };
}

function requireApproved(data: Record<string, unknown>, artifact: string): void {
  const status = String(data['status'] ?? 'UNKNOWN').toUpperCase();
  if (status !== 'APPROVED') throw new EccApprovalError(artifact, status);
}

/** Parse an approved ECC PRD. */
export function parsePrd(markdown: string): EccPrd {
  const { body, data } = splitFrontmatter(markdown);
  requireApproved(data, 'PRD');

  const titleMatch = /^#\s+(.+)$/m.exec(body);
  const acceptance: { id: string; text: string }[] = [];
  const line =
    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]*(AC-[A-Za-z0-9_.-]+)[ \t]*[:\-—][ \t]*([^\r\n]+?)[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = line.exec(body)) !== null) {
    acceptance.push({ id: match[1] as string, text: match[2] as string });
  }

  if (acceptance.length === 0) {
    throw new Error(
      'The PRD declares no acceptance criteria. Every criterion needs a stable AC-n id so the ' +
        'graph can trace coverage; a PRD without them cannot be compiled.',
    );
  }

  const featureId = String(data['feature_id'] ?? '').trim();
  if (featureId === '') {
    throw new Error('The PRD frontmatter must declare feature_id.');
  }

  return {
    feature_id: featureId,
    title: (titleMatch?.[1] ?? featureId).trim(),
    acceptance_criteria: acceptance,
  };
}

/** Split a comma- or newline-separated field value into trimmed items. */
function items(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/**
 * Split a command string into argv.
 *
 * Quoted segments are preserved so a `--tests "*Foo Bar*"` style argument is
 * not silently re-split into two arguments.
 */
export function toArgv(command: string | undefined): string[] | null {
  if (command === undefined || command.trim() === '') return null;
  const out: string[] = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(command)) !== null) {
    out.push((m[1] ?? m[2] ?? m[3]) as string);
  }
  return out.length > 0 ? out : null;
}

const EVIDENCE_KINDS = new Set<string>([
  'red',
  'green',
  'refactor',
  'regression',
  'review',
  'e2e',
  'candidate',
]);

/** Parse an approved ECC plan into behaviours. */
export function parsePlan(markdown: string): EccPlan {
  const { body, data } = splitFrontmatter(markdown);
  requireApproved(data, 'PLAN');

  const featureId = String(data['feature_id'] ?? '').trim();
  const problems: Problem[] = [];
  const behaviours: EccBehaviour[] = [];

  // Each behaviour is a "## <id> <title>" section with "- key: value" fields.
  const sections = body.split(/^##\s+/m).slice(1);
  for (const [index, section] of sections.entries()) {
    const headingEnd = section.indexOf('\n');
    const heading = (headingEnd === -1 ? section : section.slice(0, headingEnd)).trim();
    const rest = headingEnd === -1 ? '' : section.slice(headingEnd + 1);

    const idMatch = /^([A-Za-z][A-Za-z0-9_.-]*)\s*(.*)$/.exec(heading);
    const id = idMatch?.[1] ?? `B-${index + 1}`;
    const title = (idMatch?.[2] ?? heading).trim() || id;

    const fields = new Map<string, string>();
    // Horizontal whitespace only. `\s*` would match a newline, so an empty
    // field such as "- depends_on:" would swallow the following line.
    const fieldLine = /^[ \t]*[-*+][ \t]*([a-z_]+)[ \t]*:[ \t]*([^\r\n]*)$/gm;
    let f: RegExpExecArray | null;
    while ((f = fieldLine.exec(rest)) !== null) {
      fields.set((f[1] as string).toLowerCase(), (f[2] as string).trim());
    }

    const at = `/behaviours/${index}`;
    const repository = fields.get('repository') ?? null;
    if (repository === null || repository === '') {
      problems.push({
        code: 'BEHAVIOUR_MISSING_REPOSITORY',
        path: at,
        detail: `Behaviour "${id}" does not name a repository. The planner must say which repository changes.`,
      });
    }

    const redTarget = toArgv(fields.get('red_target'));
    const greenTarget = toArgv(fields.get('green_target')) ?? redTarget;
    if (redTarget === null && greenTarget === null) {
      problems.push({
        code: 'BEHAVIOUR_MISSING_VERIFIER',
        path: at,
        detail: `Behaviour "${id}" declares no red_target or green_target. A behaviour with no command cannot be verified.`,
      });
    }

    const declaredEvidence = items(fields.get('evidence')).filter((e) => EVIDENCE_KINDS.has(e));
    const requiredEvidence: EvidenceKind[] =
      declaredEvidence.length > 0
        ? (declaredEvidence as EvidenceKind[])
        : (['red', 'green', 'regression'] as EvidenceKind[]);

    behaviours.push({
      id,
      title,
      repository: repository === '' ? null : repository,
      capability: fields.get('capability') ?? null,
      acceptance_criteria: items(fields.get('acceptance_criteria')),
      allowed_paths: items(fields.get('files') ?? fields.get('allowed_paths')),
      forbidden_paths: items(fields.get('forbidden_paths')),
      depends_on: items(fields.get('depends_on')),
      contract_inputs: items(fields.get('contract_inputs')),
      contract_outputs: items(fields.get('contract_outputs')),
      required_resources: items(fields.get('resources') ?? fields.get('required_resources')),
      required_evidence: requiredEvidence,
      red_target: redTarget,
      green_target: greenTarget,
      regression: toArgv(fields.get('regression')),
    });
  }

  const known = new Set(behaviours.map((b) => b.id));
  behaviours.forEach((b, i) => {
    for (const dep of b.depends_on) {
      if (!known.has(dep)) {
        problems.push({
          code: 'UNKNOWN_BEHAVIOUR_DEPENDENCY',
          path: `/behaviours/${i}/depends_on`,
          detail: `Behaviour "${b.id}" depends on "${dep}", which the plan does not define.`,
        });
      }
    }
  });

  return { feature_id: featureId, behaviours, problems };
}

export interface CompileDraftArgs {
  prd: EccPrd;
  plan: EccPlan;
  repositories: RepositoryManifest | unknown;
  /** Resource capacities; the capacity-1 defaults are used when omitted. */
  resources?: PortfolioGraph['resources'];
}

export interface DraftGraphResult {
  graph: PortfolioGraph;
  problems: Problem[];
  requires_review: boolean;
  review_notes: string[];
}

const DEFAULT_RESOURCES: PortfolioGraph['resources'] = {
  'full-runtime': { capacity: 1 },
  'deploy-slot': { capacity: 1 },
  'browser-worker': { capacity: 2 },
  'fixture-global-reset': { capacity: 1 },
};

function capabilityIdFor(b: EccBehaviour): string {
  return b.capability ?? `CAP-${b.id.toUpperCase()}`;
}

/**
 * Build a draft portfolio graph from an approved PRD and plan.
 *
 * The result always requires human review: an automatic translation of prose
 * into an execution contract is a proposal, not an approval.
 */
export function compileDraftGraph(args: CompileDraftArgs): DraftGraphResult {
  const { prd, plan } = args;
  if (plan.feature_id !== '' && plan.feature_id !== prd.feature_id) {
    throw new Error(
      `PRD is for ${prd.feature_id} but the plan is for ${plan.feature_id}. Refusing to merge two features.`,
    );
  }

  const problems: Problem[] = [...plan.problems];
  const manifest = args.repositories as RepositoryManifest | undefined;
  const knownRepos = new Set((manifest?.repositories ?? []).map((r) => r.name));

  const nodeIdFor = (b: EccBehaviour): string =>
    `${prd.feature_id}.${b.repository ?? 'unassigned'}.${capabilityIdFor(b)}.impl`;

  const usedRepos = new Set<string>();
  const capabilities: PortfolioGraph['capabilities'] = [];
  const nodes: PortfolioGraph['nodes'] = [];
  const acIds = new Set(prd.acceptance_criteria.map((a) => a.id));
  const coveredAcs = new Set<string>();

  for (const [i, b] of plan.behaviours.entries()) {
    if (b.repository !== null) {
      if (knownRepos.size > 0 && !knownRepos.has(b.repository)) {
        problems.push({
          code: 'UNKNOWN_REPOSITORY',
          path: `/behaviours/${i}/repository`,
          detail: `Behaviour "${b.id}" names repository "${b.repository}", which is not in repositories.yaml.`,
        });
      }
      usedRepos.add(b.repository);
    }

    const capId = capabilityIdFor(b);
    if (b.repository !== null && !capabilities.some((c) => c.id === capId)) {
      capabilities.push({
        id: capId,
        repository: b.repository,
        title: b.title,
        acceptance_criteria: b.acceptance_criteria.filter((a) => acIds.has(a)),
      });
    }

    for (const ac of b.acceptance_criteria) {
      if (!acIds.has(ac)) {
        problems.push({
          code: 'UNKNOWN_ACCEPTANCE_CRITERION',
          path: `/behaviours/${i}/acceptance_criteria`,
          detail: `Behaviour "${b.id}" cites "${ac}", which the PRD does not define.`,
        });
      } else {
        coveredAcs.add(ac);
      }
    }

    const command = b.green_target ?? b.red_target ?? [];
    nodes.push({
      id: nodeIdFor(b),
      level: 'executable-node',
      repository: b.repository,
      capability: b.repository === null ? null : capId,
      node_type: 'implementation',
      depends_on: b.depends_on
        .map((dep) => plan.behaviours.find((x) => x.id === dep))
        .filter((x): x is EccBehaviour => x !== undefined)
        .map(nodeIdFor),
      allowed_paths: b.allowed_paths,
      forbidden_paths: b.forbidden_paths,
      contract_inputs: b.contract_inputs,
      contract_outputs: b.contract_outputs,
      required_resources: b.required_resources,
      required_evidence: b.required_evidence,
      verification_commands: command.length > 0 ? [{ id: 'targeted', command }] : [],
      worker: {
        model: 'sonnet',
        effort: 'high',
        max_turns: 30,
        max_wall_clock_minutes: 45,
        max_attempts: 2,
        nested_delegation: false,
      },
      invalidation_rules: [],
      acceptance_criteria: b.acceptance_criteria.filter((a) => acIds.has(a)),
    });
  }

  for (const ac of acIds) {
    if (!coveredAcs.has(ac)) {
      problems.push({
        code: 'UNCOVERED_ACCEPTANCE_CRITERION',
        path: '/acceptance_criteria',
        detail:
          `No behaviour covers "${ac}". Add a behaviour to the plan, or move the criterion out of ` +
          `scope in the PRD. A node will not be invented for it.`,
      });
    }
  }

  const graph: PortfolioGraph = {
    schema_version: 1,
    feature_id: prd.feature_id,
    title: prd.title,
    prd: 'PRD.md',
    plan: 'PLAN.md',
    acceptance_criteria: prd.acceptance_criteria,
    resources: args.resources ?? DEFAULT_RESOURCES,
    repositories: [...usedRepos].sort(),
    capabilities,
    nodes,
  };

  const reviewNotes = [
    'Worker budgets are conservative defaults, not measurements. Adjust them after a pilot.',
    'Resource capacities were not stated in the plan; the capacity-1 runtime defaults were applied.',
    'No candidate-build or e2e-scenario node was inferred. Add them deliberately.',
    'Check every ownership fence: two concurrent behaviours in one repository must not overlap.',
  ];

  return { graph, problems, requires_review: true, review_notes: reviewNotes };
}
