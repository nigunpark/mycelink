/**
 * Optional ECC adapter: an approved ECC-style PRD and plan become a draft
 * portfolio graph. Validated against the documented artifact shape only; it
 * has not been exercised against a live ECC installation.
 */
import type { PlanSourceAdapter } from '../registry.js';
import { compileDraftGraph, parsePlan, parsePrd } from './plan-adapter.js';

export const eccAdapter: PlanSourceAdapter = {
  name: 'ecc',
  description: 'ECC-style Markdown PRD + plan (front-matter status: APPROVED) to a draft graph',
  verification: 'documented-shape-only',
  inputs: ['prd', 'plan'],
  draft(input) {
    const prd = parsePrd(input.files['prd'] ?? '');
    const plan = parsePlan(input.files['plan'] ?? '');
    return compileDraftGraph({ prd, plan, repositories: input.repositories });
  },
};
