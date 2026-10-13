/**
 * The approved acceptance criteria travel verbatim, with their kind, from the
 * requirement to every worker, bound by their hashes.
 *
 * CSET-202 r2: the planner put one-line summaries of the criteria into the
 * graph ("ChangesetValidationError in @changesets/errors with sorted issues
 * and formatted message"), so every worker saw a paraphrase that lost the
 * exact formats the requirement fixes (`- <changesetId>: <message>`, the
 * UNKNOWN_PACKAGE message, exit code 1), and AC-5 (compatibility) was planned
 * as new behaviour. Now:
 *
 *  - `feature acceptance` writes a structured manifest beside the PRD
 *    (features/<F>/ACCEPTANCE.json): each criterion's id, kind and exact
 *    text, cut verbatim from the approved requirement (or taken verbatim
 *    from the requirement's structured sidecar, which must match its
 *    source), with hashes;
 *  - graph validation refuses a graph whose criteria are not exactly the
 *    manifest's (a summary, another kind, one missing or invented);
 *  - feature init binds the manifest's hash; each claim binds its node's
 *    criteria; the ticket and pack carry their exact text, kind and hash; a
 *    manifest changed after init refuses the claim, charging nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll } from '../helpers/git-fixture.js';
import { extractAcceptanceCriteria } from '../../src/engine/acceptance.js';
import { ERRORS, SHOP_FEATURE, createShop, moduleVerifier, shopCli, shopGraph, shopState, type Shop } from '../helpers/shop-fixture.js';
import { packOf, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const CSET_202 = readFileSync(join(REPO_ROOT, 'evals-public-projects', 'projects', 'changesets', 'prds', 'CSET-202', 'requirement.md'), 'utf8');

/** The shop's approved requirement, criteria as the benchmark's requirements write them. */
const REQUIREMENT = `# ${SHOP_FEATURE} — Report every invalid changeset at once

Status: approved

## Acceptance criteria

**AC-1 — the error (errors).** \`packages/errors\` exports
\`ChangesetValidationError\`, constructed from a list of issues:

- \`error.issues\` holds them sorted by \`changesetId\`, then \`code\`, then \`message\`.
- \`error.message\` is \`Invalid changesets:\` followed by one line per issue, formatted \`- <changesetId>: <message>\`.

**AC-2 — reading (read).** \`readChangesets\` reports every unparseable changeset in one \`ChangesetValidationError\`.

**AC-3 — planning (assemble).** \`assembleReleasePlan\` reports every unknown package in one \`ChangesetValidationError\`, with the message
\`Found changeset <id> for package <name> which is not in the workspace\`.

**AC-4 — CLI.** \`status\` prints the error's message once and exits with code \`1\`.

**AC-5 — compatibility.** For changesets that are all valid, everything is read, planned and printed exactly as today.

## Engineering expectations

- Tests in the package that owns each criterion.
`;

const blockOf = (id: string): string => {
  const from = REQUIREMENT.indexOf(`**${id} `);
  const next = REQUIREMENT.slice(from + 1).search(/\n\*\*AC-|\n## /);
  return REQUIREMENT.slice(from, from + 1 + next).trimEnd();
};

/** The graph a planner should write: the manifest's criteria, verbatim. */
function exactGraph(): Record<string, unknown> {
  const g = shopGraph(moduleVerifier()) as { acceptance_criteria: Record<string, unknown>[] };
  g.acceptance_criteria = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'].map((id) => ({ id, text: blockOf(id), kind: id === 'AC-5' ? 'compatibility' : 'new-behavior' }));
  return g;
}

async function withRequirement(graph: Record<string, unknown>): Promise<Shop> {
  const s = await createShop({ modules: 'structured', graph, init: false });
  mkdirSync(join(s.control, 'requirements'), { recursive: true });
  writeFileSync(join(s.control, 'requirements', `${SHOP_FEATURE}.md`), REQUIREMENT);
  commitAll(s.control, 'the approved requirement');
  return s;
}

describe('the acceptance criteria of an approved requirement, verbatim', () => {
  it("cuts every criterion of the CSET-202 requirement exactly as written, its code block and bullets included", () => {
    const criteria = extractAcceptanceCriteria(CSET_202);
    expect(criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']);
    for (const c of criteria) expect(CSET_202.includes(c.text), c.id).toBe(true);
    expect(criteria[0]!.text.startsWith('**AC-1 — the error (errors).** `@changesets/errors` exports')).toBe(true);
    expect(criteria[0]!.text).toContain('```ts\ntype ChangesetIssue = {');
    expect(criteria[0]!.text).toContain('formatted `- <changesetId>: <message>`, joined with\n  `\\n`.');
    expect(criteria[2]!.text).toContain('`Found changeset <id> for package <name> which is not in the workspace`');
    expect(criteria[3]!.text).toContain('exits with code `1`. `changeset version` changes no file in\nthat case. Every other error is reported as today.');
    expect(criteria[4]!.text).toBe('**AC-5 — compatibility.** For workspaces whose changesets are all valid,\neverything both commands print, write and return is byte-identical to today.');
  });

  it('feature acceptance writes the manifest beside the PRD: exact text, kinds as approved, hashes', async () => {
    const s = await withRequirement(exactGraph());
    const r = await shopCli(s, ['feature', 'acceptance', SHOP_FEATURE, '--source', `requirements/${SHOP_FEATURE}.md`, '--kind', 'AC-5=compatibility', '--json']);
    expect(r.err).toBe('');
    const out = JSON.parse(r.out) as { path: string; sha256: string; from: string };
    expect(out).toMatchObject({ path: `features/${SHOP_FEATURE}/ACCEPTANCE.json`, from: 'requirement' });
    const manifest = JSON.parse(readFileSync(join(s.control, out.path), 'utf8'));
    expect(manifest).toEqual({
      schema: 'mycelink-acceptance/1',
      feature_id: SHOP_FEATURE,
      source: { path: `requirements/${SHOP_FEATURE}.md`, sha256: sha256(REQUIREMENT) },
      criteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'].map((id) => ({ id, kind: id === 'AC-5' ? 'compatibility' : 'new-behavior', text: blockOf(id), sha256: sha256(blockOf(id)) })),
    });
    expect(out.sha256).toBe(sha256(readFileSync(join(s.control, out.path), 'utf8')));
  });

  it("a structured sidecar beside the requirement is the manifest, verbatim — when it matches its source", async () => {
    const s = await withRequirement(exactGraph());
    const criteria = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'].map((id) => ({ id, kind: id === 'AC-5' ? 'compatibility' : 'new-behavior', text: blockOf(id), sha256: sha256(blockOf(id)) }));
    const sidecar = { schema: 'mycelink-acceptance/1', feature_id: SHOP_FEATURE, source: { path: `requirements/${SHOP_FEATURE}.md`, sha256: sha256(REQUIREMENT) }, criteria };
    writeFileSync(join(s.control, 'requirements', `${SHOP_FEATURE}.acceptance.json`), JSON.stringify(sidecar, null, 2) + '\n');
    const r = await shopCli(s, ['feature', 'acceptance', SHOP_FEATURE, '--source', `requirements/${SHOP_FEATURE}.md`, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ from: 'sidecar' });
    expect(JSON.parse(readFileSync(join(s.featureDir, 'ACCEPTANCE.json'), 'utf8'))).toEqual(sidecar);
    // A kind that disagrees with the approved sidecar is refused: it is not the planner's to change.
    const disagree = await shopCli(s, ['feature', 'acceptance', SHOP_FEATURE, '--source', `requirements/${SHOP_FEATURE}.md`, '--kind', 'AC-5=new-behavior', '--json']);
    expect(disagree.code).not.toBe(0);
    expect(disagree.err).toMatch(/ACCEPTANCE_KIND_MISMATCH/);
    // A sidecar that no longer matches its requirement is refused.
    writeFileSync(join(s.control, 'requirements', `${SHOP_FEATURE}.md`), REQUIREMENT.replace('exits with code', 'returns'));
    const stale = await shopCli(s, ['feature', 'acceptance', SHOP_FEATURE, '--source', `requirements/${SHOP_FEATURE}.md`, '--json']);
    expect(stale.code).not.toBe(0);
    expect(stale.err).toMatch(/ACCEPTANCE_SOURCE_MISMATCH/);
  });

  it('graph validation refuses a criterion summarised, of another kind, missing or invented', async () => {
    const g = exactGraph() as { acceptance_criteria: { id: string; text: string; kind?: string }[] };
    g.acceptance_criteria[0]!.text = 'errors: ChangesetValidationError sorts its issues and lists one per line';
    g.acceptance_criteria[4]!.kind = 'new-behavior';
    g.acceptance_criteria.splice(3, 1, { id: 'AC-9', text: 'status is fast', kind: 'new-behavior' });
    const graph = g as unknown as { nodes: { id: string; acceptance_criteria?: string[] }[] };
    for (const n of graph.nodes) n.acceptance_criteria = (n.acceptance_criteria ?? []).map((id) => (id === 'AC-4' ? 'AC-9' : id));
    const s = await withRequirement(g);
    expect((await shopCli(s, ['feature', 'acceptance', SHOP_FEATURE, '--source', `requirements/${SHOP_FEATURE}.md`, '--kind', 'AC-5=compatibility', '--json'])).code).toBe(0);
    const v = JSON.parse((await shopCli(s, ['graph', 'validate', SHOP_FEATURE, '--json'])).out) as { ok: boolean; problems: { code: string; detail: string }[] };
    expect(v.ok).toBe(false);
    expect(v.problems.map((p) => p.code).sort()).toEqual(['ACCEPTANCE_CRITERION_MISSING', 'ACCEPTANCE_CRITERION_UNKNOWN', 'ACCEPTANCE_KIND_MISMATCH', 'ACCEPTANCE_TEXT_MISMATCH'].sort());
    expect(v.problems.find((p) => p.code === 'ACCEPTANCE_TEXT_MISMATCH')!.detail).toMatch(/AC-1.*verbatim.*ACCEPTANCE\.json/);
    const init = await shopCli(s, ['feature', 'init', SHOP_FEATURE]);
    expect(init.code).not.toBe(0);
    expect(existsSync(join(s.featureDir, 'STATE.json'))).toBe(false);
  });

  it('feature init binds the manifest; the claim binds its criteria; the ticket and pack carry the exact text, kind and hash; a changed manifest refuses the next claim', async () => {
    const s = await withRequirement(exactGraph());
    expect((await shopCli(s, ['feature', 'acceptance', SHOP_FEATURE, '--source', `requirements/${SHOP_FEATURE}.md`, '--kind', 'AC-5=compatibility', '--json'])).code).toBe(0);
    commitAll(s.control, 'acceptance manifest');
    const init = await shopCli(s, ['feature', 'init', SHOP_FEATURE]);
    expect(init.err).toBe('');
    const manifestPath = join(s.featureDir, 'ACCEPTANCE.json');
    expect(shopState(s).acceptance).toEqual({ path: `features/${SHOP_FEATURE}/ACCEPTANCE.json`, sha256: sha256(readFileSync(manifestPath, 'utf8')) });
    commitAll(s.control, 'feature initialised');
    const d = JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { status: string; ticket: ShopTicket & { acceptance_criteria: Record<string, unknown>[] } };
    expect(d.status).toBe('DISPATCHED');
    const expected = [{ id: 'AC-1', kind: 'new-behavior', text: blockOf('AC-1'), sha256: sha256(blockOf('AC-1')) }];
    expect(d.ticket.acceptance_criteria).toEqual(expected);
    const pack = packOf(d.ticket);
    expect(pack['acceptance_criteria']).toEqual(expected);
    const claim = shopState(s).nodes[ERRORS].claim;
    expect(claim.acceptance).toEqual({ manifest_sha256: shopState(s).acceptance.sha256, criteria_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(pack['acceptance_sha256']).toBe(claim.acceptance.criteria_sha256);
    // The exact text reaches the worker's prompt as data inside the pack (its <, > and backticks \u-escaped there).
    expect(d.ticket.prompt).toContain(String.raw`- \u003cchangesetId\u003e: \u003cmessage\u003e`);
    // Release the claim unspent, change the manifest, and dispatch again: refused before anything is claimed.
    await shopCli(s, ['session', 'reconcile', SHOP_FEATURE, '--abandon-dispatches', '--json']);
    const attempts = shopState(s).nodes[ERRORS].attempts;
    const tampered = JSON.parse(readFileSync(manifestPath, 'utf8'));
    tampered.criteria[0].text = 'errors: a summary';
    writeFileSync(manifestPath, JSON.stringify(tampered, null, 2) + '\n');
    commitAll(s.control, 'edit the manifest');
    const again = JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { status: string; detail: string };
    expect(again.status).toBe('PRECONDITION_FAILED');
    expect(again.detail).toMatch(/^ACCEPTANCE_DRIFT: /);
    expect(shopState(s).nodes[ERRORS].attempts).toBe(attempts);
    expect(shopState(s).nodes[ERRORS].claim).toBeNull();
    void YAML;
  });
});
