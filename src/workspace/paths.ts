/**
 * Canonical control-repository layout.
 *
 * Every path the controller, the hooks and the plugin commands use is derived
 * here, so there is exactly one definition of where state lives.
 */
import { join, resolve } from 'node:path';
import { assertFeatureId } from '../security/names.js';

export interface ControlPaths {
  controlRoot: string;
  repositoriesManifest: string;
  reposLock: string;
  config: string;
  contractsDir: string;
  handoffsDir: string;
  featuresDir: string;
  workDir: string;
  worktreesDir: string;
  integrationDir: string;
  brainDir: string;
}

export interface FeaturePaths {
  featureId: string;
  featureDir: string;
  prd: string;
  plan: string;
  graph: string;
  state: string;
  stateLock: string;
  loops: string;
  runs: string;
  events: string;
  decisions: string;
  changes: string;
  leases: string;
  candidatesDir: string;
  evidenceDir: string;
  sessionsRegistry: string;
  sessionsDir: string;
  contextPacksDir: string;
  checkpointsDir: string;
  scenariosDir: string;
  metricsDir: string;
}

export function controlPaths(controlRoot: string): ControlPaths {
  const root = resolve(controlRoot);
  return {
    controlRoot: root,
    repositoriesManifest: join(root, 'repositories.yaml'),
    reposLock: join(root, 'repos.lock.yaml'),
    config: join(root, 'mycelink.config.json'),
    contractsDir: join(root, 'contracts'),
    handoffsDir: join(root, 'handoffs'),
    featuresDir: join(root, 'features'),
    workDir: join(root, '.mycelink'),
    worktreesDir: join(root, '.mycelink', 'worktrees'),
    integrationDir: join(root, '.mycelink', 'integration'),
    brainDir: join(root, '.llmwiki'),
  };
}

export function featurePaths(controlRoot: string, featureId: string): FeaturePaths {
  // The id becomes a directory name under features/; refuse anything else.
  assertFeatureId(featureId);
  const dir = join(controlPaths(controlRoot).featuresDir, featureId);
  return {
    featureId,
    featureDir: dir,
    prd: join(dir, 'PRD.md'),
    plan: join(dir, 'PLAN.md'),
    graph: join(dir, 'PORTFOLIO-GRAPH.yaml'),
    state: join(dir, 'STATE.json'),
    stateLock: join(dir, 'STATE.json.lock'),
    loops: join(dir, 'LOOPS.yaml'),
    runs: join(dir, 'RUNS.jsonl'),
    events: join(dir, 'events.jsonl'),
    decisions: join(dir, 'DECISIONS.md'),
    changes: join(dir, 'CHANGES.md'),
    leases: join(dir, 'leases.json'),
    candidatesDir: join(dir, 'candidates'),
    evidenceDir: join(dir, 'evidence'),
    sessionsRegistry: join(dir, 'sessions', 'registry.json'),
    sessionsDir: join(dir, 'sessions'),
    contextPacksDir: join(dir, 'context-packs'),
    checkpointsDir: join(dir, 'checkpoints'),
    scenariosDir: join(dir, 'e2e'),
    metricsDir: join(dir, 'metrics'),
  };
}

/** Evidence directory for one node, e.g. evidence/FEAT-1.repo.cap.impl/. */
export function nodeEvidenceDir(controlRoot: string, featureId: string, nodeId: string): string {
  return join(featurePaths(controlRoot, featureId).evidenceDir, safeSegment(nodeId));
}

/** A node id is safe as a path segment already, but normalise defensively. */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
