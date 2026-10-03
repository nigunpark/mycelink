/**
 * Plan-source adapters.
 *
 * The core of Mycelink consumes exactly one input: a portfolio graph that a
 * human has reviewed and the validator has accepted. Everything that turns
 * some other planning artifact into such a graph — an ECC PRD/plan today, an
 * issue-tracker export tomorrow — is an adapter behind this interface.
 *
 * An adapter only ever produces a DRAFT. It cannot write canonical state,
 * approve anything, or bypass graph validation; adding one never requires a
 * change to graph, state, scheduling or evidence code.
 */
import type { PortfolioGraph, Problem, RepositoryManifest } from '../model/types.js';
import { eccAdapter } from './ecc/index.js';

export interface DraftGraphResult {
  graph: PortfolioGraph;
  problems: Problem[];
  /** Always true for adapter output: a translation is a proposal, not an approval. */
  requires_review: boolean;
  review_notes: string[];
}

export interface PlanSourceInput {
  /** Text of each declared input, keyed by its role (for example "prd"). */
  files: Record<string, string>;
  repositories?: RepositoryManifest;
}

export interface PlanSourceAdapter {
  readonly name: string;
  readonly description: string;
  /**
   * How far the adapter has been proven: "tested" against real output of the
   * source system, or only against its documented shape.
   */
  readonly verification: 'tested' | 'documented-shape-only';
  /** Input roles; each becomes a `--<role> <file>` CLI flag. */
  readonly inputs: readonly string[];
  draft(input: PlanSourceInput): DraftGraphResult;
}

export class UnknownAdapterError extends Error {
  constructor(name: string) {
    super(`Unknown plan-source adapter "${name}". Known: ${[...adapters.keys()].join(', ') || '(none)'}.`);
    this.name = 'UnknownAdapterError';
  }
}

const adapters = new Map<string, PlanSourceAdapter>();

export function registerAdapter(adapter: PlanSourceAdapter): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.name)) {
    throw new Error(`Adapter name "${adapter.name}" must be lowercase letters, digits and "-".`);
  }
  if (adapters.has(adapter.name)) throw new Error(`Adapter "${adapter.name}" is already registered.`);
  adapters.set(adapter.name, adapter);
}

export function unregisterAdapter(name: string): void {
  adapters.delete(name);
}

export function getAdapter(name: string): PlanSourceAdapter {
  const adapter = adapters.get(name);
  if (!adapter) throw new UnknownAdapterError(name);
  return adapter;
}

export function listAdapters(): PlanSourceAdapter[] {
  return [...adapters.values()].sort((a, b) => a.name.localeCompare(b.name));
}

registerAdapter(eccAdapter);
