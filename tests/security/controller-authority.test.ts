/**
 * Controller authority is positive, not the absence of a worker token.
 *
 * A host-dispatched module-worker has Bash and runs as the same OS user as
 * the host. It used to be enough for it to omit `--capability` (or unset
 * MYCELINK_CLAIM_TOKEN) to run any controller-only command. Now every
 * controller-only command needs `--authority <key>`: a random key minted by
 * `mycelink controller open` and handed only to whoever opened it. Only its
 * hash is stored, it never enters a ticket, prompt, context pack, worktree
 * or environment, and it cannot be minted while any claim is live, which is
 * exactly when a worker exists.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { CORE, WORK, hostPortfolio } from '../helpers/host-loop.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { CONTROLLER_ONLY, main, type CliIo } from '../../src/cli/cli.js';
import { controllerKey } from '../helpers/authority.js';
import { resolveRef } from '../../src/git/git.js';

afterAll(() => cleanupTmpRoots());

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI in-process with exactly `env` overlaid (undefined deletes a variable). */
async function raw(p: Portfolio, argv: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const code = await main([...argv, '--control-root', p.control], io);
    return { code, out, err };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The host's key: rotated from the one the fixture's setup opened, as a host holding it would. */
async function open(p: Portfolio): Promise<string> {
  const r = await raw(p, ['controller', 'open', '--json', '--authority', controllerKey(p.control)]);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  const out = JSON.parse(r.out) as { authority: string };
  expect(out.authority).toMatch(/^[0-9a-f]{64}$/);
  return out.authority;
}

/** One sample argv per controller-only table entry; arguments past the role check do not matter. */
function controllerCommands(p: Portfolio): string[][] {
  const out: string[][] = [];
  for (const [group, subs] of Object.entries(CONTROLLER_ONLY)) {
    if (subs === '*') {
      out.push(group === 'init' ? [group, p.control] : [group, FEATURE_ID]);
      continue;
    }
    for (const sub of subs) out.push([group, sub, FEATURE_ID, CORE]);
  }
  return out;
}

function snapshot(p: Portfolio): string {
  const files = ['STATE.json', 'events.jsonl', 'DECISIONS.md', 'leases.json'].map((f) => join(p.featureDir, f));
  const h = createHash('sha256');
  for (const f of files) h.update(existsSync(f) ? readFileSync(f) : Buffer.from('-'));
  for (const repo of [p.core, p.api, p.app]) h.update(resolveRef(repo, 'main'));
  h.update(existsSync(join(p.control, 'repositories.yaml')) ? readFileSync(join(p.control, 'repositories.yaml')) : '-');
  return h.digest('hex');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('controller authority', () => {
  let p: Portfolio;
  let authority: string;
  let ticket: DispatchTicket;

  beforeEach(async () => {
    p = await hostPortfolio();
    authority = await open(p);
    const d = await raw(p, ['dispatch', FEATURE_ID, '--json', '--authority', authority]);
    expect(d.err).toBe('');
    ticket = (JSON.parse(d.out) as { ticket: DispatchTicket }).ticket;
    expect(ticket.node_id).toBe(CORE);
  });

  it('covers every controller-only table entry', () => {
    const cmds = controllerCommands(p).map((a) => a.slice(0, 2).join(' '));
    for (const must of ['dispatch', 'deliver', 'init', 'node claim', 'decision apply', 'orchestrate run', 'session reconcile']) {
      expect(cmds.some((c) => c.startsWith(must))).toBe(true);
    }
  });

  it('a worker with its token presented, omitted or unset cannot run any controller-only command', async () => {
    const before = snapshot(p);
    const variants: [string, string[], Record<string, string | undefined>][] = [
      ['flag', ['--capability', ticket.capability], { MYCELINK_CLAIM_TOKEN: undefined }],
      ['env', [], { MYCELINK_CLAIM_TOKEN: ticket.capability }],
      ['omitted', [], { MYCELINK_CLAIM_TOKEN: undefined }],
      ['empty-env', [], { MYCELINK_CLAIM_TOKEN: '' }],
    ];
    for (const argv of controllerCommands(p)) {
      for (const [label, extra, env] of variants) {
        const r = await raw(p, [...argv, ...extra], env);
        const tag = `${argv.slice(0, 2).join(' ')} [${label}]`;
        expect(`${tag} exit ${r.code}`).not.toBe(`${tag} exit 0`);
        expect(`${tag}: ${r.err.split('\n')[0]}`).toMatch(/: (ROLE_DENIED|CONTROLLER_AUTHORITY_REQUIRED)/);
      }
    }
    expect(snapshot(p)).toBe(before);
  });

  it('refuses a guessed authority, the worker capability posing as one, and a bare flag', async () => {
    for (const forged of ['0'.repeat(64), ticket.capability, authority.slice(0, 63) + (authority.endsWith('0') ? '1' : '0')]) {
      const r = await raw(p, ['deliver', FEATURE_ID, '--authority', forged], { MYCELINK_CLAIM_TOKEN: undefined });
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/CONTROLLER_AUTHORITY_INVALID/);
    }
    const bare = await raw(p, ['session', 'reconcile', FEATURE_ID, '--authority'], { MYCELINK_CLAIM_TOKEN: undefined });
    expect(bare.err).toMatch(/CONTROLLER_AUTHORITY_(REQUIRED|INVALID)/);
    // Authority does not launder a presented worker capability either.
    const both = await raw(p, ['deliver', FEATURE_ID, '--authority', authority, '--capability', ticket.capability]);
    expect(both.err).toMatch(/ROLE_DENIED/);
  });

  it('cannot be minted by anyone without the current key, nor rotated while a claim is live', async () => {
    const r = await raw(p, ['controller', 'open', '--json'], { MYCELINK_CLAIM_TOKEN: undefined });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/CONTROLLER_AUTHORITY_EXISTS/);
    // Even the key's holder cannot rotate it while a claim is live.
    const rotate = await raw(p, ['controller', 'open', '--json', '--authority', authority], { MYCELINK_CLAIM_TOKEN: undefined });
    expect(rotate.err).toMatch(/CONTROLLER_BUSY/);
    const takeover = await raw(p, ['controller', 'open', '--takeover', '--json']);
    expect(takeover.code).not.toBe(0);
    expect(takeover.err).toMatch(/TTY/);
    // The host's key still works.
    const reconcile = await raw(p, ['session', 'reconcile', FEATURE_ID, '--json', '--authority', authority]);
    expect(reconcile.err).toBe('');
  });

  it('never reaches the worker: not in the ticket, prompt, pack, worktree, state or environment', async () => {
    expect(JSON.stringify(ticket)).not.toContain(authority);
    const places = [
      ...walk(ticket.worktree as string),
      ...walk(p.featureDir),
      ...walk(join(p.control, '.mycelink')),
    ];
    for (const f of places) expect(`${f}:${readFileSync(f, 'utf8').includes(authority)}`).toBe(`${f}:false`);
    expect(Object.values(process.env).some((v) => v === authority)).toBe(false);
  });

  it('keeps the normal host path usable: settle with the claim, dispatch and deliver with the authority', async () => {
    fakeAgent(ticket, WORK[CORE]!, p.control);
    const s = await raw(p, ['settle', FEATURE_ID, CORE, '--capability', ticket.capability, '--json']);
    expect(s.err).toBe('');
    expect(JSON.parse(s.out)).toMatchObject({ outcome: 'DONE' });
    for (let i = 0; i < 10; i++) {
      const d = await raw(p, ['dispatch', FEATURE_ID, '--json', '--authority', authority]);
      expect(d.err).toBe('');
      const out = JSON.parse(d.out) as { status: string; ticket?: DispatchTicket };
      if (out.status !== 'DISPATCHED') {
        expect(out.status).toBe('ALL_SETTLED');
        break;
      }
      const t = out.ticket as DispatchTicket;
      fakeAgent(t, WORK[t.node_id]!, p.control);
      expect((await raw(p, ['settle', FEATURE_ID, t.node_id, '--capability', t.capability, '--json'])).code).toBe(0);
    }
    const delivered = await raw(p, ['deliver', FEATURE_ID, '--json', '--authority', authority]);
    expect(delivered.err).toBe('');
    expect(JSON.parse(delivered.out)).toMatchObject({ ok: true, status: 'ACCEPTED' });
  });

  it('a worker that settles its own claim still cannot mint a key afterwards', async () => {
    fakeAgent(ticket, WORK[CORE]!, p.control);
    // The worker holds its capability, so it can end its own claim...
    expect((await raw(p, ['settle', FEATURE_ID, CORE, '--capability', ticket.capability])).code).toBe(0);
    // ...and now no claim is live anywhere. Minting still needs the current key.
    const omitted = await raw(p, ['controller', 'open', '--json'], { MYCELINK_CLAIM_TOKEN: undefined });
    expect(omitted.code).not.toBe(0);
    expect(omitted.err).toMatch(/CONTROLLER_AUTHORITY_EXISTS/);
    const presented = await raw(p, ['controller', 'open', '--json'], { MYCELINK_CLAIM_TOKEN: ticket.capability });
    expect(presented.err).toMatch(/ROLE_DENIED/);
    const forged = await raw(p, ['controller', 'open', '--json', '--authority', ticket.capability], { MYCELINK_CLAIM_TOKEN: undefined });
    expect(forged.err).toMatch(/CONTROLLER_AUTHORITY_INVALID/);
    expect((await raw(p, ['controller', 'open', '--takeover', '--json'])).err).toMatch(/TTY/);
    // The host's key is untouched.
    expect((await raw(p, ['session', 'reconcile', FEATURE_ID, '--authority', authority])).code).toBe(0);
  });

  it('rotates: the holder of the current key opens a new one (no live claim) and the old one stops working', async () => {
    fakeAgent(ticket, WORK[CORE]!, p.control);
    expect((await raw(p, ['settle', FEATURE_ID, CORE, '--capability', ticket.capability])).code).toBe(0);
    const r = await raw(p, ['controller', 'open', '--json', '--authority', authority]);
    expect(r.err).toBe('');
    const next = (JSON.parse(r.out) as { authority: string }).authority;
    expect(next).not.toBe(authority);
    const old = await raw(p, ['session', 'reconcile', FEATURE_ID, '--authority', authority]);
    expect(old.err).toMatch(/CONTROLLER_AUTHORITY_INVALID/);
    expect((await raw(p, ['session', 'reconcile', FEATURE_ID, '--authority', next])).code).toBe(0);
  });
});
