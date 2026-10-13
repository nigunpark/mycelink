/**
 * The approved acceptance criteria, structured and bound.
 *
 * CSET-202 r2: the planner put one-line summaries of the criteria into the
 * graph, so every worker saw a paraphrase that lost the exact formats the
 * requirement fixes, and the compatibility criterion was planned as new
 * behaviour. The criteria now travel verbatim, with their kind, from the
 * approved requirement to every worker:
 *
 *  - `features/<F>/ACCEPTANCE.json` is the manifest: each criterion's id,
 *    kind (new-behavior, compatibility, declaration) and exact text with its
 *    SHA-256, and the source requirement it was cut from, by hash. It is cut
 *    verbatim from the requirement's markdown (every `**AC-n ...` paragraph,
 *    `- **AC-n**` item or `### AC-n` section of its acceptance criteria,
 *    code blocks and lists included), or copied from the requirement's own
 *    structured sidecar (`<requirement>.acceptance.json`), which must match
 *    its source;
 *  - the graph's criteria must be exactly the manifest's: a summary, another
 *    kind, a criterion missing or invented is refused (graph validation and
 *    feature init);
 *  - feature init binds the manifest's hash in STATE.json, each claim binds
 *    its node's criteria by hash, and the context pack carries their exact
 *    text, kind and hash; a manifest changed afterwards refuses the next claim
 *    (ACCEPTANCE_DRIFT), charging nothing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CriterionKind, PortfolioGraph, Problem } from '../model/types.js';
import { featurePaths } from '../workspace/paths.js';
import { normalizeCriterionKind } from './criteria.js';

export const ACCEPTANCE_FILE = 'ACCEPTANCE.json';
export const ACCEPTANCE_SCHEMA = 'mycelink-acceptance/1';
const KINDS: readonly CriterionKind[] = ['new-behavior', 'compatibility', 'declaration'];
const ID = /^AC-[A-Za-z0-9_.-]+$/;

export interface AcceptanceCriterion {
  id: string;
  kind: CriterionKind;
  text: string;
  sha256: string;
}

export interface AcceptanceManifest {
  schema: typeof ACCEPTANCE_SCHEMA;
  feature_id: string;
  source: { path: string; sha256: string };
  criteria: AcceptanceCriterion[];
}

export class AcceptanceError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AcceptanceError';
    this.code = code;
  }
}

/** The manifest the feature was initialised with changed (or went): nothing is claimed or settled under it. */
export class AcceptanceDriftError extends AcceptanceError {
  constructor(nodeId: string, detail: string) {
    super('ACCEPTANCE_DRIFT', `${nodeId}: ${detail}. The approved criteria are fixed when the feature is initialised: restore the manifest, or plan the change as a new feature (feature supersede). Nothing was claimed or charged.`);
    this.name = 'AcceptanceDriftError';
  }
}

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Where a criterion block starts: `**AC-n`, `- **AC-n`, `- AC-n:` or a heading `### AC-n`. */
const START = [/^\*\*(AC-[A-Za-z0-9_.-]+)\b/, /^[-*+]\s+\*\*(AC-[A-Za-z0-9_.-]+)\b/, /^#{2,6}\s+\**(AC-[A-Za-z0-9_.-]+)\b/, /^[-*+]\s+(AC-[A-Za-z0-9_.-]+)\s*[:.—–-]/];
const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Every acceptance criterion of a requirement's markdown, verbatim: the
 * block from each criterion's start to the next one, the end of its
 * acceptance criteria section, or the next other heading; code blocks are
 * opaque. The section is the first heading that names acceptance criteria,
 * else the whole document. Throws on a criterion named twice.
 */
export function extractAcceptanceCriteria(markdown: string): { id: string; text: string }[] {
  const lines = markdown.split('\n');
  let from = 0;
  let to = lines.length;
  const section = lines.findIndex((l) => HEADING.test(l) && /acceptance criteria/i.test(l));
  if (section >= 0) {
    from = section + 1;
    const level = (HEADING.exec(lines[section] as string)?.[1] ?? '#').length;
    let fenced = false;
    for (let i = from; i < lines.length; i++) {
      const l = lines[i] as string;
      if (FENCE.test(l)) fenced = !fenced;
      const h = fenced ? null : HEADING.exec(l);
      if (h && (h[1] as string).length <= level) {
        to = i;
        break;
      }
    }
  }
  const out: { id: string; text: string }[] = [];
  let current: { id: string; lines: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    out.push({ id: current.id, text: current.lines.join('\n').trimEnd() });
    current = null;
  };
  let fenced = false;
  for (let i = from; i < to; i++) {
    const l = lines[i] as string;
    if (!fenced) {
      const id = START.map((rx) => rx.exec(l)?.[1]).find((x) => x !== undefined);
      if (id !== undefined) {
        close();
        current = { id, lines: [l] };
        if (FENCE.test(l)) fenced = !fenced;
        continue;
      }
      if (HEADING.test(l)) {
        close();
        continue;
      }
    }
    if (FENCE.test(l)) fenced = !fenced;
    if (current !== null) (current as { lines: string[] }).lines.push(l);
  }
  close();
  const seen = new Set<string>();
  for (const c of out) {
    if (seen.has(c.id)) throw new AcceptanceError('ACCEPTANCE_DUPLICATE', `${c.id} is defined more than once in the requirement`);
    seen.add(c.id);
  }
  return out;
}

/** `requirements/X.md` -> `requirements/X.acceptance.json`: the requirement's structured sidecar. */
export function sidecarPath(source: string): string {
  return source.replace(/\.(md|markdown)$/i, '') + '.acceptance.json';
}

/** A manifest from criteria cut from `sourceBytes` (at `sourcePath`, relative to the control root). */
export function buildManifest(featureId: string, sourcePath: string, sourceBytes: Buffer, criteria: { id: string; kind?: string; text: string }[]): AcceptanceManifest {
  return {
    schema: ACCEPTANCE_SCHEMA,
    feature_id: featureId,
    source: { path: sourcePath.replace(/\\/g, '/'), sha256: sha256(sourceBytes) },
    criteria: criteria.map((c) => ({ id: c.id, kind: normalizeCriterionKind(c.kind), text: c.text, sha256: sha256(c.text) })),
  };
}

/** Why `value` is not a sound manifest of `featureId`, its criteria verbatim in `source` when given; empty when it is. */
export function manifestProblems(value: unknown, options: { featureId?: string; source?: Buffer } = {}): string[] {
  const problems: string[] = [];
  const m = value as Partial<AcceptanceManifest> | null;
  if (m === null || typeof m !== 'object') return ['not a JSON object'];
  if (m.schema !== ACCEPTANCE_SCHEMA) problems.push(`schema is not ${ACCEPTANCE_SCHEMA}`);
  if (typeof m.feature_id !== 'string') problems.push('no feature_id');
  else if (options.featureId !== undefined && m.feature_id !== options.featureId) problems.push(`it is the manifest of ${m.feature_id}, not ${options.featureId}`);
  if (!m.source || typeof m.source.path !== 'string' || typeof m.source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.source.sha256)) problems.push('no source path and sha256');
  if (!Array.isArray(m.criteria) || m.criteria.length === 0) {
    problems.push('no criteria');
    return problems;
  }
  const seen = new Set<string>();
  const text = options.source?.toString('utf8');
  for (const c of m.criteria) {
    if (typeof c?.id !== 'string' || !ID.test(c.id)) {
      problems.push(`a criterion id is not AC-<id>: ${JSON.stringify(c?.id)}`);
      continue;
    }
    if (seen.has(c.id)) problems.push(`${c.id} is listed twice`);
    seen.add(c.id);
    if (!KINDS.includes(c.kind)) problems.push(`${c.id}: kind ${JSON.stringify(c.kind)} is not one of ${KINDS.join(', ')}`);
    if (typeof c.text !== 'string' || c.text.trim() === '') problems.push(`${c.id}: no text`);
    else {
      if (c.sha256 !== sha256(c.text)) problems.push(`${c.id}: sha256 is not the hash of its text`);
      if (text !== undefined && !text.includes(c.text)) problems.push(`${c.id}: its text is not verbatim in the requirement`);
    }
  }
  if (options.source !== undefined && m.source && m.source.sha256 !== sha256(options.source)) problems.push(`the requirement ${m.source.path} is not the one it was cut from (sha256 ${m.source.sha256.slice(0, 12)})`);
  return problems;
}

/** The feature's manifest, its bytes' SHA-256 and control-root-relative path; null when it has none. Throws when it is unsound. */
export function loadAcceptanceManifest(controlRoot: string, featureId: string): { manifest: AcceptanceManifest; sha256: string; path: string } | null {
  const file = join(featurePaths(controlRoot, featureId).featureDir, ACCEPTANCE_FILE);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new AcceptanceError('ACCEPTANCE_MANIFEST_INVALID', `${ACCEPTANCE_FILE} of ${featureId} is not JSON: ${(err as Error).message}`);
  }
  const problems = manifestProblems(parsed, { featureId });
  if (problems.length > 0) throw new AcceptanceError('ACCEPTANCE_MANIFEST_INVALID', `${ACCEPTANCE_FILE} of ${featureId}: ${problems.join('; ')}`);
  return { manifest: parsed as AcceptanceManifest, sha256: sha256(bytes), path: `features/${featureId}/${ACCEPTANCE_FILE}` };
}

/**
 * Why the graph's criteria are not exactly the manifest's: every approved
 * criterion present, nothing invented, each text verbatim and each kind the
 * approved one. The planner copies them; it never summarises.
 */
export function graphAcceptanceProblems(graph: PortfolioGraph, manifest: AcceptanceManifest): Problem[] {
  const problems: Problem[] = [];
  const where = `features/${manifest.feature_id}/${ACCEPTANCE_FILE}`;
  const byId = new Map(manifest.criteria.map((c) => [c.id, c]));
  const inGraph = new Set(graph.acceptance_criteria.map((a) => a.id));
  for (const c of manifest.criteria) {
    if (!inGraph.has(c.id)) problems.push({ code: 'ACCEPTANCE_CRITERION_MISSING', path: '/acceptance_criteria', detail: `${c.id} of the approved criteria (${where}) is not in the graph; copy every criterion from it` });
  }
  graph.acceptance_criteria.forEach((a, i) => {
    const approved = byId.get(a.id);
    if (approved === undefined) {
      problems.push({ code: 'ACCEPTANCE_CRITERION_UNKNOWN', path: `/acceptance_criteria/${i}`, detail: `${a.id} is not an approved criterion (${where}); the graph invents none` });
      return;
    }
    if (a.text !== approved.text) {
      problems.push({ code: 'ACCEPTANCE_TEXT_MISMATCH', path: `/acceptance_criteria/${i}/text`, detail: `${a.id}'s text is not the approved criterion verbatim; copy it from ${where} (mycelink feature acceptance ${manifest.feature_id} --json prints it), never summarise it` });
    }
    if (normalizeCriterionKind(a.kind) !== approved.kind) {
      problems.push({ code: 'ACCEPTANCE_KIND_MISMATCH', path: `/acceptance_criteria/${i}/kind`, detail: `${a.id} is approved as ${approved.kind}, not ${normalizeCriterionKind(a.kind)} (${where})` });
    }
  });
  return problems;
}
