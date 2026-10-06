/**
 * Claim capabilities and roles.
 *
 * Every claim gets a random 256-bit capability. It is handed out once, to
 * whoever claimed the node (the worker it is dispatched to), and only its
 * SHA-256 is stored: STATE.json, events and evidence are readable by every
 * worker on the machine, so a stored raw value would let any worker act for
 * any other claim.
 *
 * Worker-scoped mutations (gates, evidence, settle) must present the
 * capability of the current claim. Controller-only operations (claiming,
 * integrating, cutting candidates, delivering) refuse anyone who presents a
 * capability at all, flag or environment: a worker acting through its own
 * capability cannot widen its role.
 *
 * Within one OS user this is a guard against confused or shortcut-taking
 * agents, not against hostile code running as that user.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ParsedArgs } from '../cli/args.js';
import type { NodeRuntime } from '../model/types.js';

export const CAPABILITY_ENV = 'MYCELINK_CLAIM_TOKEN';
const CAPABILITY_FORMAT = /^[0-9a-f]{64}$/;

export type CapabilityCode = 'CAPABILITY_REQUIRED' | 'CAPABILITY_INVALID' | 'NOT_CLAIMED';

export class CapabilityError extends Error {
  readonly code: CapabilityCode;
  constructor(code: CapabilityCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

export class RoleDeniedError extends Error {
  constructor(operation: string) {
    super(
      `ROLE_DENIED: "${operation}" is a controller operation and cannot be run with a worker claim capability.`,
    );
    this.name = 'RoleDeniedError';
  }
}

export function newCapability(): { raw: string; sha256: string } {
  const raw = randomBytes(32).toString('hex');
  return { raw, sha256: capabilityHash(raw) };
}

export function capabilityHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented capability against a stored hash. */
export function capabilityMatches(raw: string, sha256: string): boolean {
  if (!CAPABILITY_FORMAT.test(raw) || !CAPABILITY_FORMAT.test(sha256)) return false;
  return timingSafeEqual(Buffer.from(capabilityHash(raw), 'hex'), Buffer.from(sha256, 'hex'));
}

/** The capability a caller presented: `--capability`, else the worker environment. */
export function presentedCapability(args: ParsedArgs): string | undefined {
  const flag = args.flags['capability'];
  if (typeof flag === 'string' && flag !== '') return flag;
  const env = process.env[CAPABILITY_ENV];
  return env !== undefined && env !== '' ? env : undefined;
}

/** Refuse a controller-only operation to anyone holding a worker capability. */
export function assertControllerRole(args: ParsedArgs, operation: string): void {
  const flag = args.flags['capability'];
  if ((typeof flag === 'string' && flag !== '') || flag === true || presentedCapability(args) !== undefined) {
    throw new RoleDeniedError(operation);
  }
}

/** Check that `raw` is the capability of the node's current claim. */
export function assertClaimCapability(nodeId: string, runtime: NodeRuntime | undefined, raw: string | undefined): void {
  const claim = runtime?.claim ?? null;
  if (claim === null) {
    throw new CapabilityError('NOT_CLAIMED', `${nodeId} has no active claim; claim it through the controller first.`);
  }
  if (claim.capability_sha256 === undefined) {
    throw new CapabilityError(
      'CAPABILITY_REQUIRED',
      `${nodeId}'s claim predates claim capabilities; reconcile and re-claim it.`,
    );
  }
  if (raw === undefined) {
    throw new CapabilityError('CAPABILITY_REQUIRED', `${nodeId} is claimed; pass the claim's --capability.`);
  }
  if (!capabilityMatches(raw, claim.capability_sha256)) {
    throw new CapabilityError(
      'CAPABILITY_INVALID',
      `the capability presented is not the one for ${nodeId}'s current claim (stale, rotated or for another node).`,
    );
  }
}
