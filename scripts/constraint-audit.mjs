#!/usr/bin/env node
/**
 * The constraint/freedom audit's checkable record (docs/evals/constraint-audit.json,
 * explained in docs/CONSTRAINT_FREEDOM_AUDIT.md).
 *
 *   node scripts/constraint-audit.mjs --check   verify the record (CI; exit 1 on drift)
 *   node scripts/constraint-audit.mjs --write   regenerate its generated sections
 *
 * Generated, from the repository itself:
 *  - `case_coupling`: every mention of a public case (CSET-*, PCM-*, Changesets,
 *    Petclinic) in the shipped plugin — its TypeScript source read token by
 *    token (comments apart from code: an identifier, string, template or
 *    regular expression naming a case is case-specific core branching), the
 *    model-facing text (agents, skills, commands, templates, hooks, schemas,
 *    bin) and the built bundle — and how many test files name each case;
 *  - `summary`: the inventory's counts by classification and status, and the
 *    run history's totals.
 * Hand-authored, and checked: each inventory entry's fields, classification,
 * status and scope, its anchor (a file that exists and holds the quoted text)
 * and its tests (files that exist); every id appears in the document. The
 * cross-case policy section is checked by tests/security/worker-freedom-envelope.test.ts.
 * Neither file may hold an absolute path, a session/tool/request id or a
 * credential-looking string.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = join(ROOT, 'docs', 'evals', 'constraint-audit.json');
const DOC = join(ROOT, 'docs', 'CONSTRAINT_FREEDOM_AUDIT.md');
const CASE = /cset-?[0-9]+|changesets?|petclinic|pcm-?[0-9]+/i;
const CASE_G = new RegExp(CASE.source, 'gi');
const CASE_IDS = ['CSET-201', 'CSET-202', 'CSET-203', 'PCM-101', 'PCM-102', 'PCM-103'];
const MODEL_FACING = ['agents', 'skills', 'commands', 'templates', 'hooks', 'schemas', 'bin'];
const CLASSES = ['HARD_SAFETY', 'EVIDENCE_GATE', 'RECOVERABLE_ADVISORY', 'OVERCONSTRAINT'];
const STATUSES = ['retained', 'fixed', 'relaxed', 'retained-candidate'];
const SCOPES = ['runtime', 'benchmark'];
const FIELDS = ['id', 'layer', 'rule', 'classification', 'status', 'scope', 'actor', 'invariant', 'blocked', 'false_positive_risk', 'recovery', 'charges_product_attempt', 'tests', 'anchor'];

const rel = (p) => relative(ROOT, p).split('\\').join('/');

function* walk(dir, ext) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, ext);
    else if (ext.some((e) => name.endsWith(e))) yield p;
  }
}

/** Case mentions in one script's tokens: in comments, and in code (identifiers, strings, templates, regular expressions). */
function tokenMentions(file, kind) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const code = [];
  const visit = (n) => {
    const literal = ts.isStringLiteralLike(n) || ts.isIdentifier(n) || ts.isRegularExpressionLiteral(n) || n.kind === ts.SyntaxKind.TemplateHead || n.kind === ts.SyntaxKind.TemplateMiddle || n.kind === ts.SyntaxKind.TemplateTail;
    if (literal && CASE.test(n.getText(sf))) code.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const all = (text.match(CASE_G) ?? []).length;
  return { all, code };
}

function caseCoupling() {
  const perFile = {};
  let comments = 0;
  const codePaths = [];
  for (const f of walk(join(ROOT, 'src'), ['.ts'])) {
    const m = tokenMentions(f, ts.ScriptKind.TS);
    if (m.all === 0) continue;
    perFile[rel(f)] = m.all;
    comments += m.all - m.code.length;
    for (const line of m.code) codePaths.push(`${rel(f)}:${line}`);
  }
  const modelFacing = {};
  for (const d of MODEL_FACING) {
    if (!existsSync(join(ROOT, d))) continue;
    for (const f of walk(join(ROOT, d), [''])) {
      const n = (readFileSync(f, 'utf8').match(CASE_G) ?? []).length;
      if (n > 0) modelFacing[rel(f)] = n;
    }
  }
  const bundle = tokenMentions(join(ROOT, 'dist', 'mycelink.mjs'), ts.ScriptKind.JS);
  const tests = {};
  const testFiles = [...walk(join(ROOT, 'tests'), ['.ts', '.mjs'])];
  for (const id of CASE_IDS) tests[id] = testFiles.filter((f) => readFileSync(f, 'utf8').includes(id)).length;
  return {
    pattern: CASE.source,
    plugin_source: {
      files_with_mentions: Object.keys(perFile).length,
      mentions: Object.values(perFile).reduce((a, b) => a + b, 0),
      comment_mentions: comments,
      code_token_mentions: codePaths.length,
      code_token_paths: codePaths,
      per_file: perFile,
    },
    model_facing: { mentions: Object.values(modelFacing).reduce((a, b) => a + b, 0), per_file: modelFacing },
    bundle: { file: 'dist/mycelink.mjs', mentions: bundle.all, code_token_mentions: bundle.code.length },
    test_files_naming_case: tests,
  };
}

function summary(record) {
  const by = (key, values) => Object.fromEntries(values.map((v) => [v, record.inventory.filter((e) => e[key] === v).length]));
  const runtimeOnly = record.inventory.filter((e) => e.scope.length === 1 && e.scope[0] === 'runtime').length;
  const benchmarkOnly = record.inventory.filter((e) => e.scope.length === 1 && e.scope[0] === 'benchmark').length;
  const h = record.history;
  const sum = (k) => h.reduce((a, r) => a + (r[k] ?? 0), 0);
  return {
    enforcement_points: record.inventory.length,
    by_classification: by('classification', CLASSES),
    by_status: by('status', STATUSES),
    scope: { both: record.inventory.length - runtimeOnly - benchmarkOnly, runtime_only: runtimeOnly, benchmark_only: benchmarkOnly },
    history: {
      runs: h.length,
      genuine_product_or_safety: h.filter((r) => r.kind !== 'harness-friction').length,
      harness_friction: h.filter((r) => r.kind === 'harness-friction').length,
      product_attempts_charged_for_orchestration: sum('product_attempts_charged_for_orchestration'),
      reviewer_generations_spent_on_transport_or_format: sum('reviewer_generations_spent_on_transport_or_format'),
      sessions_lost_to_harness: sum('sessions_lost_to_harness'),
    },
  };
}

function problems(record, docText) {
  const out = [];
  const ids = new Set();
  for (const e of record.inventory ?? []) {
    const at = e.id ?? '(no id)';
    for (const k of FIELDS) if (e[k] === undefined) out.push(`${at}: no ${k}`);
    if (ids.has(e.id)) out.push(`${at}: duplicate id`);
    ids.add(e.id);
    if (!CLASSES.includes(e.classification)) out.push(`${at}: classification ${e.classification}`);
    if (!STATUSES.includes(e.status)) out.push(`${at}: status ${e.status}`);
    if (!Array.isArray(e.scope) || e.scope.length === 0 || e.scope.some((s) => !SCOPES.includes(s))) out.push(`${at}: scope ${JSON.stringify(e.scope)}`);
    for (const t of e.tests ?? []) if (!existsSync(join(ROOT, t))) out.push(`${at}: no test file ${t}`);
    const a = e.anchor ?? {};
    if (typeof a.file !== 'string' || !existsSync(join(ROOT, a.file))) out.push(`${at}: no anchor file ${a.file}`);
    else if (typeof a.contains !== 'string' || !readFileSync(join(ROOT, a.file), 'utf8').includes(a.contains)) out.push(`${at}: ${a.file} does not hold ${JSON.stringify(a.contains)}`);
    if (!docText.includes(e.id)) out.push(`${at}: not in docs/CONSTRAINT_FREEDOM_AUDIT.md`);
  }
  for (const r of record.history ?? []) {
    for (const t of r.evidence ?? []) if (!existsSync(join(ROOT, t))) out.push(`history ${r.run}: no evidence file ${t}`);
    if (!docText.includes(`| ${r.run} |`)) out.push(`history ${r.run}: not in the document's table`);
  }
  for (const [name, text] of [['constraint-audit.json', JSON.stringify(record)], ['CONSTRAINT_FREEDOM_AUDIT.md', docText]]) {
    if (/[A-Za-z]:[\\/]{1,2}(Users|home)|\/(Users|home)\/[a-z]/i.test(text)) out.push(`${name}: holds an absolute user path`);
    if (/toolu_[A-Za-z0-9]{6,}|req_0[A-Za-z0-9]{6,}|msg_[A-Za-z0-9]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text)) out.push(`${name}: holds a session, tool or request id`);
    if (/(sk-ant-|ghp_|github_pat_|xox[bp]-|AKIA[0-9A-Z]{12}|BEGIN [A-Z ]*PRIVATE KEY)/.test(text)) out.push(`${name}: holds a credential-looking string`);
  }
  return out;
}

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  process.stderr.write('usage: node scripts/constraint-audit.mjs --check | --write\n');
  process.exit(2);
}
const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const docText = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
const generated = { case_coupling: caseCoupling(), summary: summary(record) };
if (mode === '--write') {
  const next = { ...record, ...generated };
  writeFileSync(RECORD, JSON.stringify(next, null, 2) + '\n');
  process.stdout.write(`wrote ${rel(RECORD)}\n`);
  process.exit(0);
}
const found = problems(record, docText);
for (const k of Object.keys(generated)) if (JSON.stringify(record[k]) !== JSON.stringify(generated[k])) found.push(`${k} drifted: run node scripts/constraint-audit.mjs --write`);
if (generated.case_coupling.plugin_source.code_token_mentions !== 0) found.push(`case-specific core code: ${generated.case_coupling.plugin_source.code_token_paths.join(', ')}`);
if (generated.case_coupling.model_facing.mentions !== 0) found.push(`case-specific model-facing text: ${Object.keys(generated.case_coupling.model_facing.per_file).join(', ')}`);
if (found.length > 0) {
  process.stderr.write(found.map((p) => `constraint-audit: ${p}`).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write(`constraint-audit: ok (${record.inventory.length} enforcement points, ${record.history.length} runs, 0 case-specific core code tokens)\n`);
