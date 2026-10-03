/**
 * LLM Wiki Brain adapter (optional).
 *
 * This is deliberately a *retrieval and capture* layer, never an authority.
 * Order of authority stays: current instruction > PRD/PLAN/DECISIONS >
 * source + real evidence > harness state > verified Brain > partial or stale
 * memory > conversation. A memory never marks a node DONE.
 *
 * Retrieval is deterministic and lexical; no embeddings, no vector store, no
 * model call. An existing `.codewiki` is adopted as a code-memory sub-vault
 * rather than migrated.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { validateAgainstSchema } from '../schema/registry.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import type { Problem } from '../model/types.js';
import type { MemoryRef } from '../sessions/context-pack.js';

export type MemoryType =
  | 'policy'
  | 'procedure'
  | 'episode'
  | 'decision'
  | 'concept'
  | 'pitfall'
  | 'code-module'
  | 'code-contract'
  | 'code-flow';

export type MemoryStatus =
  | 'verified'
  | 'instructed_not_verified'
  | 'partial'
  | 'stale'
  | 'contested'
  | 'superseded'
  | 'invalid'
  | 'archived';

export interface MemoryFrontmatter {
  id: string;
  title: string;
  type: MemoryType;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
  source_refs: { kind: string; ref: string; sha256?: string; symbol?: string }[];
  related?: string[];
  supersedes?: string[];
  superseded_by?: string[];
  watch?: string[];
  triggers?: string[];
  tags?: string[];
  verified_commit?: string | null;
  verification: {
    structural: 'passed' | 'failed' | 'not_run';
    references: 'passed' | 'failed' | 'not_run';
    build: 'passed' | 'failed' | 'not_run';
    tests: 'passed' | 'failed' | 'not_run';
    runtime: 'passed' | 'failed' | 'not_run';
  };
}

export interface MemoryPage {
  frontmatter: MemoryFrontmatter;
  body: string;
  path: string;
}

const DIR_FOR: Record<MemoryType, string> = {
  policy: 'policies',
  procedure: 'procedures',
  episode: 'episodes',
  decision: 'decisions',
  concept: 'concepts',
  pitfall: 'pitfalls',
  'code-module': join('code', 'modules'),
  'code-contract': join('code', 'contracts'),
  'code-flow': join('code', 'flows'),
};

/** Status weighting for retrieval: a stale memory must never outrank a verified one. */
const STATUS_WEIGHT: Record<MemoryStatus, number> = {
  verified: 100,
  instructed_not_verified: 70,
  partial: 50,
  stale: 20,
  contested: 15,
  superseded: 0,
  invalid: 0,
  archived: 0,
};

/** Statuses excluded from default retrieval but still searchable for audit. */
const EXCLUDED_BY_DEFAULT: ReadonlySet<MemoryStatus> = new Set<MemoryStatus>([
  'superseded',
  'invalid',
  'archived',
]);

export function brainRoot(controlRoot: string, override?: string | null): string {
  return resolve(controlRoot, override ?? '.llmwiki');
}

export function initBrain(root: string): string {
  for (const dir of [
    root,
    ...Object.values(DIR_FOR).map((d) => join(root, d)),
    join(root, 'queries'),
    join(root, 'review'),
    join(root, 'archive'),
    join(root, 'manifests'),
    join(root, 'evidence'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const schema = join(root, 'SCHEMA.md');
  if (!existsSync(schema)) writeTextAtomic(schema, SCHEMA_MD);
  const index = join(root, 'index.md');
  if (!existsSync(index)) writeTextAtomic(index, '# LLM Wiki Brain index\n');
  return root;
}

const SCHEMA_MD = `# LLM Wiki Brain schema

Every page carries YAML frontmatter validated against
\`schemas/memory-page.schema.json\`.

Authority order (highest first):

1. The user's current explicit instruction and organisation policy
2. Approved PRD / PLAN / DECISIONS
3. Source code plus real build, test and runtime evidence
4. Harness canonical files (GRAPH, STATE, evidence)
5. Verified Brain pages
6. Partial, stale or contested pages
7. Conversation history and auto memory

Rules:

- \`not_run\` is never rewritten to \`passed\`.
- A code claim without a source path, symbol or hash is rejected.
- A user instruction that was never executed is \`instructed_not_verified\`,
  not \`verified\`.
- A correction creates a new page and a supersession link; it never silently
  rewrites history.
- Secrets are never stored: record the key name and whether it is set.
- A memory alone never advances a production node to DONE.
`;

function parseFrontmatter(text: string): { frontmatter: unknown; body: string } | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const yaml = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter: YAML.parse(yaml) as unknown, body };
}

export function renderPage(frontmatter: MemoryFrontmatter, body: string): string {
  return `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body.trimEnd()}\n`;
}

export function pagePath(root: string, frontmatter: MemoryFrontmatter): string {
  return join(root, DIR_FOR[frontmatter.type], `${frontmatter.id}.md`);
}

export interface WritePageResult {
  path: string;
  problems: Problem[];
}

/** Validate and write one page. A schema-invalid page is never written. */
export function writePage(root: string, frontmatter: MemoryFrontmatter, body: string): WritePageResult {
  const problems = validateAgainstSchema('memory-page', frontmatter);

  // A code claim must be anchored in real source, not just prose.
  if (frontmatter.type.startsWith('code-')) {
    const anchored = frontmatter.source_refs.some(
      (r) => r.kind === 'source' && (r.sha256 !== undefined || r.symbol !== undefined),
    );
    if (!anchored) {
      problems.push({
        code: 'CODE_CLAIM_UNANCHORED',
        path: '/source_refs',
        detail:
          'A code page needs at least one source ref with a symbol or content hash; a description alone is not evidence.',
      });
    }
  }
  if (frontmatter.status === 'verified') {
    const anyVerification = Object.values(frontmatter.verification).some((v) => v === 'passed');
    if (!anyVerification) {
      problems.push({
        code: 'VERIFIED_WITHOUT_VERIFICATION',
        path: '/status',
        detail: 'status "verified" requires at least one verification step that actually passed.',
      });
    }
  }

  if (problems.length > 0) return { path: '', problems };

  const file = pagePath(root, frontmatter);
  mkdirSync(join(root, DIR_FOR[frontmatter.type]), { recursive: true });
  writeTextAtomic(file, renderPage(frontmatter, body));
  return { path: file, problems: [] };
}

export function readPage(file: string): MemoryPage | null {
  if (!existsSync(file)) return null;
  const parsed = parseFrontmatter(readFileSync(file, 'utf8'));
  if (parsed === null) return null;
  const problems = validateAgainstSchema('memory-page', parsed.frontmatter);
  if (problems.length > 0) return null;
  return {
    frontmatter: parsed.frontmatter as MemoryFrontmatter,
    body: parsed.body,
    path: file,
  };
}

/** Every valid page under the Brain root. */
export function listPages(root: string): MemoryPage[] {
  if (!existsSync(root)) return [];
  const out: MemoryPage[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'archive') continue;
        walk(full);
      } else if (entry.endsWith('.md') && entry !== 'SCHEMA.md' && entry !== 'index.md') {
        const page = readPage(full);
        if (page) out.push(page);
      }
    }
  };
  walk(root);
  return out;
}

export interface SelectOptions {
  query: string;
  featureId?: string;
  nodeId?: string;
  paths?: string[];
  limit?: number;
  includeExcluded?: boolean;
}

export interface Selection extends MemoryRef {
  score: number;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/)
    .filter((t) => t.length > 2);
}

/** First meaningful line of the body, used as the bounded summary. */
function summarise(page: MemoryPage): string {
  const line = page.body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  return (line ?? page.frontmatter.title).slice(0, 300);
}

/**
 * Deterministic lexical selection.
 *
 * Signals, strongest first: policy status, explicit trigger match, stable id
 * or path match, tag/title match, then body term overlap — all weighted by
 * page status so a stale page is surfaced with a warning rather than ranked
 * as fact.
 */
export function selectMemories(root: string, options: SelectOptions): Selection[] {
  const pages = listPages(root);
  const queryTokens = new Set(tokens(options.query));
  for (const p of options.paths ?? []) for (const t of tokens(p)) queryTokens.add(t);
  if (options.nodeId) for (const t of tokens(options.nodeId)) queryTokens.add(t);

  const scored: Selection[] = [];
  for (const page of pages) {
    const fm = page.frontmatter;
    if (!options.includeExcluded && EXCLUDED_BY_DEFAULT.has(fm.status)) continue;

    // Relevance first. A policy must outrank other types *when it matches*,
    // but an unconditional bonus would return every policy for every query,
    // which is how a recall system starts lying.
    let score = 0;
    for (const trigger of fm.triggers ?? []) {
      if (options.query.toLowerCase().includes(trigger.toLowerCase())) score += 60;
    }
    for (const tag of fm.tags ?? []) if (queryTokens.has(tag.toLowerCase())) score += 20;
    for (const t of tokens(fm.title)) if (queryTokens.has(t)) score += 12;
    for (const t of tokens(fm.id)) if (queryTokens.has(t)) score += 10;
    for (const ref of fm.source_refs) {
      for (const t of tokens(ref.ref)) if (queryTokens.has(t)) score += 8;
    }
    const bodyTokens = new Set(tokens(page.body));
    for (const t of queryTokens) if (bodyTokens.has(t)) score += 2;

    if (score === 0) continue;

    if (fm.type === 'policy') score += 40;
    score += STATUS_WEIGHT[fm.status] / 10;

    const warning =
      fm.status === 'stale'
        ? 'STALE: re-verify against current source before relying on this.'
        : fm.status === 'contested'
          ? 'CONTESTED: the user description and the code disagree.'
          : fm.status === 'instructed_not_verified'
            ? 'INSTRUCTED BUT NEVER EXECUTED here.'
            : fm.status === 'partial'
              ? 'PARTIAL: only one side of this was verified.'
              : undefined;

    scored.push({
      id: fm.id,
      type: fm.type,
      status: fm.status,
      summary: summarise(page),
      path: relative(root, page.path).replace(/\\/g, '/'),
      ...(warning ? { warning } : {}),
      score,
    });
  }

  scored.sort((a, b) => (b.score === a.score ? (a.id < b.id ? -1 : 1) : b.score - a.score));
  return scored.slice(0, options.limit ?? 10);
}

/** Pages whose watched source paths changed; they become `stale`, not wrong. */
export function markStale(root: string, changedPaths: string[]): string[] {
  const changed = changedPaths.map((p) => p.replace(/\\/g, '/'));
  const affected: string[] = [];
  for (const page of listPages(root)) {
    const fm = page.frontmatter;
    if (fm.status === 'stale' || EXCLUDED_BY_DEFAULT.has(fm.status)) continue;
    const watched = [...(fm.watch ?? []), ...fm.source_refs.filter((r) => r.kind === 'source').map((r) => r.ref)];
    const hit = watched.some((w) => changed.some((c) => c === w || c.startsWith(w.replace(/\/$/, '') + '/')));
    if (!hit) continue;
    const next: MemoryFrontmatter = { ...fm, status: 'stale', updated_at: new Date().toISOString() };
    writeTextAtomic(page.path, renderPage(next, page.body));
    affected.push(fm.id);
  }
  return affected;
}

/** Record a supersession without destroying the old page. */
export function supersede(root: string, oldId: string, newId: string): boolean {
  const page = listPages(root).find((p) => p.frontmatter.id === oldId);
  if (!page) return false;
  const next: MemoryFrontmatter = {
    ...page.frontmatter,
    status: 'superseded',
    superseded_by: [...new Set([...(page.frontmatter.superseded_by ?? []), newId])],
    updated_at: new Date().toISOString(),
  };
  writeTextAtomic(page.path, renderPage(next, page.body));
  return true;
}

export interface ConsolidationFinding {
  code: 'DUPLICATE_TRIGGER' | 'ORPHAN_REFERENCE' | 'UNVERIFIED_LONG_LIVED' | 'PROMOTION_CANDIDATE';
  ids: string[];
  detail: string;
}

/**
 * Report consolidation candidates. Nothing is merged automatically: only an
 * exact duplicate would be safe, and even that goes to a review queue.
 */
export function consolidate(root: string): ConsolidationFinding[] {
  const pages = listPages(root);
  const findings: ConsolidationFinding[] = [];

  const byTrigger = new Map<string, string[]>();
  for (const page of pages) {
    if (page.frontmatter.type !== 'procedure') continue;
    for (const trigger of page.frontmatter.triggers ?? []) {
      const key = trigger.toLowerCase();
      byTrigger.set(key, [...(byTrigger.get(key) ?? []), page.frontmatter.id]);
    }
  }
  for (const [trigger, ids] of byTrigger) {
    if (ids.length > 1) {
      findings.push({
        code: 'DUPLICATE_TRIGGER',
        ids,
        detail: `${ids.length} procedures claim the trigger "${trigger}"; a reviewer must pick one.`,
      });
    }
  }

  const known = new Set(pages.map((p) => p.frontmatter.id));
  for (const page of pages) {
    const dangling = (page.frontmatter.related ?? []).filter((r) => !known.has(r));
    if (dangling.length > 0) {
      findings.push({
        code: 'ORPHAN_REFERENCE',
        ids: [page.frontmatter.id],
        detail: `references missing pages: ${dangling.join(', ')}`,
      });
    }
  }

  // Episodes repeating the same lesson are procedure promotion candidates.
  const lessons = new Map<string, string[]>();
  for (const page of pages) {
    if (page.frontmatter.type !== 'episode') continue;
    for (const tag of page.frontmatter.tags ?? []) {
      lessons.set(tag, [...(lessons.get(tag) ?? []), page.frontmatter.id]);
    }
  }
  for (const [tag, ids] of lessons) {
    if (ids.length >= 2) {
      findings.push({
        code: 'PROMOTION_CANDIDATE',
        ids,
        detail: `${ids.length} episodes share "${tag}"; consider promoting a procedure (keep the episodes).`,
      });
    }
  }

  for (const page of pages) {
    if (page.frontmatter.status !== 'verified') continue;
    const anyPassed = Object.values(page.frontmatter.verification).some((v) => v === 'passed');
    if (!anyPassed) {
      findings.push({
        code: 'UNVERIFIED_LONG_LIVED',
        ids: [page.frontmatter.id],
        detail: 'marked verified but no verification step records a pass.',
      });
    }
  }

  return findings;
}

/**
 * Adopt an existing `.codewiki` as a code-memory sub-vault.
 *
 * Deliberately non-destructive: nothing is moved or rewritten, so current
 * tests and references keep working. Only an index pointer is written.
 */
export function adoptCodewiki(controlRoot: string, brain: string): { adopted: boolean; path: string } {
  const codewiki = resolve(controlRoot, '.codewiki');
  if (!existsSync(codewiki)) return { adopted: false, path: codewiki };
  mkdirSync(join(brain, 'code'), { recursive: true });
  writeTextAtomic(
    join(brain, 'code', 'SUBVAULT.md'),
    [
      '# Adopted code-memory sub-vault',
      '',
      `Authoritative code memory currently lives in \`${relative(controlRoot, codewiki).replace(/\\/g, '/')}\`.`,
      '',
      'It is referenced here, not migrated: moving it would break existing',
      'extractors, manifests and tests. Migration is a separate, approved',
      'change request after a pilot and a rollback check.',
      '',
    ].join('\n'),
  );
  return { adopted: true, path: codewiki };
}
