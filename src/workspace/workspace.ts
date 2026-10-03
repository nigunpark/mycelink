/**
 * Loading and initialising a control repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import type {
  FeatureState_,
  PortfolioGraph,
  RepositoryManifest,
  ValidationResult,
} from '../model/types.js';
import { validateGraph, validateRepositories } from '../graph/validate.js';
import { loadState } from '../state/feature-state.js';
import { featurePaths, controlPaths, type FeaturePaths, type ControlPaths } from './paths.js';
import { writeTextAtomic } from '../state/atomic-json.js';

export interface MycelinkConfig {
  schema_version: 1;
  /** Executable used by the Claude CLI session adapter. */
  claude_executable: string;
  /** 'claude-background' in production; 'fake-claude' in the automated suite. */
  session_adapter: 'claude-background' | 'fake-claude';
  /** Extra argv prepended to every worker session invocation. */
  claude_extra_args: string[];
  /** Hard ceiling on a worker session, independent of node budgets. */
  session_timeout_ms: number;
  /** Bytes allowed in a worker context pack. */
  context_pack_max_bytes: number;
  /** Bytes allowed in SessionStart / UserPromptSubmit hook output. */
  hook_session_start_max_bytes: number;
  hook_prompt_delta_max_bytes: number;
  /** Optional LLM Wiki Brain root, relative to the control repo. */
  brain_dir: string | null;
  /**
   * Allow verification commands that declare shell: true. Off by default: a
   * shell script interprets everything in it, so enabling this trusts every
   * graph author with arbitrary command execution.
   */
  allow_shell_commands: boolean;
  /**
   * Allow claude_extra_args to disable Claude Code permission checks
   * (--dangerously-skip-permissions, bypassPermissions). Off by default.
   */
  allow_dangerous_permission_bypass: boolean;
}

export const DEFAULT_CONFIG: MycelinkConfig = {
  schema_version: 1,
  claude_executable: 'claude',
  session_adapter: 'claude-background',
  claude_extra_args: [],
  session_timeout_ms: 45 * 60 * 1000,
  context_pack_max_bytes: 16_384,
  hook_session_start_max_bytes: 4096,
  hook_prompt_delta_max_bytes: 2048,
  brain_dir: null,
  allow_shell_commands: false,
  allow_dangerous_permission_bypass: false,
};

export interface Workspace {
  paths: ControlPaths;
  config: MycelinkConfig;
  repositories: RepositoryManifest;
}

export class WorkspaceError extends Error {}

export function loadConfig(controlRoot: string): MycelinkConfig {
  const file = controlPaths(controlRoot).config;
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MycelinkConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function loadRepositories(controlRoot: string): RepositoryManifest {
  const paths = controlPaths(controlRoot);
  if (!existsSync(paths.repositoriesManifest)) {
    throw new WorkspaceError(`No repositories.yaml at ${paths.repositoriesManifest}`);
  }
  const parsed = YAML.parse(readFileSync(paths.repositoriesManifest, 'utf8')) as unknown;
  const result = validateRepositories(parsed);
  if (!result.ok) {
    throw new WorkspaceError(
      'repositories.yaml is invalid: ' + result.problems.map((p) => p.detail).join('; '),
    );
  }
  return parsed as RepositoryManifest;
}

export function loadWorkspace(controlRoot: string): Workspace {
  return {
    paths: controlPaths(controlRoot),
    config: loadConfig(controlRoot),
    repositories: loadRepositories(controlRoot),
  };
}

/** Absolute path of a declared repository, resolved against the control repo. */
export function repositoryPath(ws: Workspace, name: string): string {
  const repo = ws.repositories.repositories.find((r) => r.name === name);
  if (!repo) throw new WorkspaceError(`Repository "${name}" is not declared in repositories.yaml`);
  return resolve(ws.paths.controlRoot, repo.path);
}

export interface LoadedFeature {
  paths: FeaturePaths;
  graph: PortfolioGraph;
  state: FeatureState_;
  stateRevision: number;
}

export function loadGraph(controlRoot: string, featureId: string): PortfolioGraph {
  const paths = featurePaths(controlRoot, featureId);
  if (!existsSync(paths.graph)) {
    throw new WorkspaceError(`No PORTFOLIO-GRAPH.yaml for feature "${featureId}" at ${paths.graph}`);
  }
  return YAML.parse(readFileSync(paths.graph, 'utf8')) as PortfolioGraph;
}

export function validateFeatureGraph(controlRoot: string, featureId: string): ValidationResult {
  const graph = loadGraph(controlRoot, featureId);
  let repositories: unknown;
  try {
    repositories = loadRepositories(controlRoot);
  } catch {
    repositories = undefined;
  }
  return validateGraph(graph, repositories === undefined ? {} : { repositories });
}

export function loadFeature(controlRoot: string, featureId: string): LoadedFeature {
  const paths = featurePaths(controlRoot, featureId);
  const graph = loadGraph(controlRoot, featureId);
  const doc = loadState(paths.featureDir);
  if (doc === null) {
    throw new WorkspaceError(`Feature "${featureId}" has no STATE.json; run "mycelink feature init".`);
  }
  return { paths, graph, state: doc.data, stateRevision: doc.revision };
}

/** Create the directory skeleton for a control repository. */
export function initControlRepo(controlRoot: string, config: Partial<MycelinkConfig> = {}): ControlPaths {
  const paths = controlPaths(controlRoot);
  for (const dir of [
    paths.controlRoot,
    paths.contractsDir,
    paths.handoffsDir,
    paths.featuresDir,
    paths.workDir,
    paths.worktreesDir,
    paths.integrationDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(paths.config)) {
    writeTextAtomic(paths.config, JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2) + '\n');
  }
  const keep = join(paths.featuresDir, '.gitkeep');
  if (!existsSync(keep)) writeFileSync(keep, '');
  return paths;
}

/** Create the directory skeleton for one feature. */
export function initFeatureDirs(controlRoot: string, featureId: string): FeaturePaths {
  const paths = featurePaths(controlRoot, featureId);
  for (const dir of [
    paths.featureDir,
    paths.candidatesDir,
    paths.evidenceDir,
    paths.sessionsDir,
    paths.contextPacksDir,
    paths.checkpointsDir,
    paths.scenariosDir,
    paths.metricsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}
