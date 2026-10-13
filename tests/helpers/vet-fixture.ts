/**
 * A PCM-101-shaped portfolio, small enough for every platform: one Maven-
 * layout repository, `clinic`, with two runtime modules — visits-service and
 * api-gateway — whose tests are Java test classes. A stand-in for `mvnw test`
 * with Surefire (tools/surefire.mjs, committed in the repository like a
 * wrapper) runs each test method by its expectations and writes
 * `target/surefire-reports/TEST-<class>.xml` exactly as Surefire names its
 * results: `classname` the test's binary class name (`pkg.Outer$Nested`),
 * `name` its method (`m`, or `m(int)[1]` for a parameterized invocation). So
 * every gate publishes the class-qualified JUnit names the real Petclinic
 * modules publish, while the Java reader declares bare methods.
 *
 * The feature, VET-101 (record which vet handled a visit):
 *   AC-1 visits   a visit stores its vet
 *   AC-2 visits   a non-positive vet is rejected
 *   AC-3 gateway  owner details carry each visit's vet name
 *   AC-4 gateway  the vet name is null when vets-service fails
 *   AC-5 compatibility: existing responses keep their shape
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { main, type CliIo } from '../../src/cli/cli.js';
import { modulesOf, verifierFor, type ResolvedModule } from '../../src/engine/modules.js';
import type { RepositoryDecl } from '../../src/model/types.js';
import { buildHookSettings } from '../../src/workspace/hook-settings.js';
import { ensureScratchIgnored } from '../../src/workspace/workspace.js';
import { asController } from './authority.js';
import { commitAll, git, makeGitRepo } from './git-fixture.js';
import { makeTmpDir } from './tmp.js';

export const VET_FEATURE = 'VET-101';
export const VISITS_NODE = `${VET_FEATURE}.visits.vet.impl`;
export const GATEWAY_NODE = `${VET_FEATURE}.gateway.vetname.impl`;
export const VISITS_VERIFY = `${VET_FEATURE}.visits.compat.verify`;
export const GATEWAY_VERIFY = `${VET_FEATURE}.gateway.compat.verify`;
export const VET_CANDIDATE = `${VET_FEATURE}.release.candidate.build`;

const VISITS_DIR = 'clinic-visits-service';
const GATEWAY_DIR = 'clinic-api-gateway';
const VPKG = 'org/example/clinic/visits';
const GPKG = 'org/example/clinic/gateway';

export const VISIT = `${VISITS_DIR}/src/main/java/${VPKG}/Visit.java`;
export const VISIT_RESOURCE = `${VISITS_DIR}/src/main/java/${VPKG}/VisitResource.java`;
export const VISIT_RESOURCE_TEST = `${VISITS_DIR}/src/test/java/${VPKG}/VisitResourceTest.java`;
export const VISIT_VET_TEST = `${VISITS_DIR}/src/test/java/${VPKG}/VisitVetTest.java`;
export const VISIT_DETAILS = `${GATEWAY_DIR}/src/main/java/${GPKG}/VisitDetails.java`;
export const GATEWAY_CONTROLLER = `${GATEWAY_DIR}/src/main/java/${GPKG}/ApiGatewayController.java`;
export const GATEWAY_CONTROLLER_TEST = `${GATEWAY_DIR}/src/test/java/${GPKG}/ApiGatewayControllerTest.java`;
export const OWNER_DETAILS_TEST = `${GATEWAY_DIR}/src/test/java/${GPKG}/OwnerDetailsVetNameTest.java`;

/** The binary class names Surefire reports, and the full names gates publish (`<class>#<method>`). */
export const VISIT_VET_CLASS = 'org.example.clinic.visits.VisitVetTest';
export const VISIT_RESOURCE_CLASS = 'org.example.clinic.visits.VisitResourceTest';
export const OWNER_DETAILS_CLASS = 'org.example.clinic.gateway.OwnerDetailsVetNameTest';
export const GATEWAY_CONTROLLER_CLASS = 'org.example.clinic.gateway.ApiGatewayControllerTest';

/**
 * `mvnw -pl <module> test` with Surefire, for this repository: every `*Test.java` of each module's src/test/java, each
 * `@Test` method (and each `@ValueSource` invocation of a `@ParameterizedTest`) passing when every `Expect.contains` /
 * `Expect.absent` of its body holds on the working tree; one TEST-<class>.xml per class, as Surefire writes them.
 */
export const SUREFIRE = `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('-pl');
const modules = at >= 0 ? argv[at + 1].split(',') : readdirSync('.').filter((d) => existsSync(join(d, 'src', 'test', 'java'))).sort();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sources = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? sources(p) : n.endsWith('Test.java') ? [p] : []; });
const close = (src, open) => { let d = 0; for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return i; } return src.length; };
let run = 0;
let failed = 0;
const lines = [];
for (const mod of modules) {
  const reports = join(mod, 'target', 'surefire-reports');
  rmSync(reports, { recursive: true, force: true });
  mkdirSync(reports, { recursive: true });
  const root = join(mod, 'src', 'test', 'java');
  if (!existsSync(root)) continue;
  for (const file of sources(root).sort()) {
    const src = readFileSync(file, 'utf8');
    const pkg = (/^package\\s+([\\w.]+);/m.exec(src) || [])[1] || '';
    const classes = [];
    for (const m of src.matchAll(/(?<![\\w.])class\\s+(\\w+)[^{]*\\{/g)) {
      const open = m.index + m[0].length - 1;
      classes.push({ name: m[1], open, end: close(src, open) });
    }
    if (classes.length === 0) continue;
    const byClass = new Map();
    for (const m of src.matchAll(/@(Test|ParameterizedTest)\\b([\\s\\S]*?)void\\s+(\\w+)\\s*\\(([^)]*)\\)[^{]*\\{/g)) {
      const open = m.index + m[0].length - 1;
      const body = src.slice(open, close(src, open));
      const chain = classes.filter((c) => c.open < m.index && m.index < c.end).map((c) => c.name);
      const classname = (pkg ? pkg + '.' : '') + chain.join('$');
      const expectations = [...body.matchAll(/Expect\\.(contains|absent)\\("([^"]+)",\\s*"((?:\\\\.|[^"\\\\])*)"\\)/g)];
      const ok = expectations.every((e) => {
        const text = existsSync(e[2]) ? readFileSync(e[2], 'utf8') : '';
        const has = text.includes(JSON.parse('"' + e[3] + '"'));
        return e[1] === 'contains' ? has : !has;
      });
      const cases = byClass.get(classname) || [];
      if (m[1] === 'ParameterizedTest') {
        const values = ((/@ValueSource\\(ints\\s*=\\s*\\{([^}]*)\\}\\)/.exec(m[2]) || [])[1] || '1').split(',').map((v) => v.trim()).filter(Boolean);
        const types = m[4].split(',').map((p) => p.trim().split(/\\s+/).slice(0, -1).join(' ')).filter(Boolean);
        values.forEach((_, i) => cases.push({ name: m[3] + '(' + types.join(', ') + ')[' + (i + 1) + ']', ok }));
      } else cases.push({ name: m[3], ok });
      byClass.set(classname, cases);
    }
    for (const [classname, cases] of byClass) {
      run += cases.length;
      const bad = cases.filter((c) => !c.ok);
      failed += bad.length;
      for (const c of bad) lines.push('[ERROR] ' + classname + '.' + c.name + ' expected: <true> but was: <false>');
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\\n<testsuite name="' + esc(classname) + '" tests="' + cases.length + '" failures="' + bad.length + '" errors="0" skipped="0">\\n' +
        cases.map((c) => '  <testcase name="' + esc(c.name) + '" classname="' + esc(classname) + '" time="0.001">' + (c.ok ? '' : '<failure message="expected: &lt;true&gt; but was: &lt;false&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected: &lt;true&gt; but was: &lt;false&gt;</failure>') + '</testcase>').join('\\n') +
        '\\n</testsuite>\\n';
      writeFileSync(join(reports, 'TEST-' + classname + '.xml'), xml);
    }
  }
}
for (const l of lines) console.log(l);
console.log('[INFO] Tests run: ' + run + ', Failures: ' + failed + ', Errors: 0, Skipped: 0');
console.log(failed > 0 ? '[INFO] BUILD FAILURE' : '[INFO] BUILD SUCCESS');
process.exit(failed > 0 ? 1 : 0);
`;

export const BASE_FILES: Record<string, string> = {
  '.gitignore': 'target/\n',
  'README.md': '# clinic\n',
  'tools/surefire.mjs': SUREFIRE,
  [VISIT]: `package org.example.clinic.visits;

class Visit {
    Integer id;
    Integer petId;
    String description;
}
`,
  [VISIT_RESOURCE]: `package org.example.clinic.visits;

class VisitResource {
    // GET /owners/{ownerId}/pets/{petId}/visits
    java.util.List<Visit> visitsOfPet(int petId) { return java.util.List.of(); }
}
`,
  [VISIT_RESOURCE_TEST]: `package org.example.clinic.visits;

import org.junit.jupiter.api.Test;

class VisitResourceTest {

    @Test
    void shouldFetchVisits() {
        Expect.contains("${VISIT_RESOURCE}", "visitsOfPet");
    }
}
`,
  [VISIT_DETAILS]: `package org.example.clinic.gateway;

record VisitDetails(Integer id, Integer petId, String description) { }
`,
  [GATEWAY_CONTROLLER]: `package org.example.clinic.gateway;

class ApiGatewayController {
    OwnerDetails ownerDetails(int ownerId) { return null; }
}
`,
  [GATEWAY_CONTROLLER_TEST]: `package org.example.clinic.gateway;

import org.junit.jupiter.api.Test;

class ApiGatewayControllerTest {

    @Test
    void getOwnerDetails_withAvailableVisitsService() {
        Expect.contains("${GATEWAY_CONTROLLER}", "ownerDetails");
    }
}
`,
};

/** The visits worker's RED: methods only, as a JUnit 5 class declares them; a parameterized one. */
export const VISIT_VET_RED = `package org.example.clinic.visits;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

@SpringBootTest
@AutoConfigureMockMvc
class VisitVetTest {

    @Test
    void createWithVetStoresAndReturnsIt() {
        Expect.contains("${VISIT}", "Integer vetId;");
    }

    @ParameterizedTest
    @ValueSource(ints = {0, -1})
    void createWithNonPositiveVetIsRejected(int vetId) {
        Expect.contains("${VISIT}", "@Min(1)");
    }
}
`;

export const VISIT_IMPL = `package org.example.clinic.visits;

class Visit {
    Integer id;
    Integer petId;
    String description;
    @Min(1)
    Integer vetId;
}
`;

/** The gateway worker's RED: a nested configuration class beside the tests, and a @Nested test class. */
export const OWNER_DETAILS_RED = `package org.example.clinic.gateway;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

@WebFluxTest(controllers = ApiGatewayController.class)
@Import({OwnerDetailsVetNameTest.Stubs.class})
class OwnerDetailsVetNameTest {

    @TestConfiguration
    static class Stubs {
        @Bean
        WebClient.Builder webClientBuilder() {
            return WebClient.builder();
        }
    }

    @Test
    void visitsCarryVetIdAndVetName() {
        Expect.contains("${VISIT_DETAILS}", "String vetName");
    }

    @Nested
    class WhenVetsServiceFails {
        @Test
        void vetNameIsNull() {
            Expect.contains("${GATEWAY_CONTROLLER}", "onErrorReturn");
        }
    }
}
`;

export const VISIT_DETAILS_IMPL = `package org.example.clinic.gateway;

record VisitDetails(Integer id, Integer petId, String description, Integer vetId, String vetName) { }
`;

export const GATEWAY_CONTROLLER_IMPL = `package org.example.clinic.gateway;

class ApiGatewayController {
    OwnerDetails ownerDetails(int ownerId) { return vets().map(this::withVetNames).onErrorReturn(withoutVetNames()); }
}
`;

/** Each producer's work, and the tests its criteria name (by their class-qualified full names, as the gates print them). */
export const VET_WORK = {
  [VISITS_NODE]: {
    tests: { [VISIT_VET_TEST]: VISIT_VET_RED },
    impl: { [VISIT]: VISIT_IMPL },
    criteria: [
      { criterion: 'AC-1', gate: 'red' as const, full_name: `${VISIT_VET_CLASS}#createWithVetStoresAndReturnsIt` },
      { criterion: 'AC-2', gate: 'red' as const, full_name: `${VISIT_VET_CLASS}#createWithNonPositiveVetIsRejected(int)[1]` },
      { criterion: 'AC-5', gate: 'green' as const, full_name: `${VISIT_RESOURCE_CLASS}#shouldFetchVisits` },
    ],
  },
  [GATEWAY_NODE]: {
    tests: { [OWNER_DETAILS_TEST]: OWNER_DETAILS_RED },
    impl: { [VISIT_DETAILS]: VISIT_DETAILS_IMPL, [GATEWAY_CONTROLLER]: GATEWAY_CONTROLLER_IMPL },
    criteria: [
      { criterion: 'AC-3', gate: 'red' as const, full_name: `${OWNER_DETAILS_CLASS}#visitsCarryVetIdAndVetName` },
      { criterion: 'AC-4', gate: 'red' as const, full_name: `${OWNER_DETAILS_CLASS}$WhenVetsServiceFails#vetNameIsNull` },
      { criterion: 'AC-5', gate: 'green' as const, full_name: `${GATEWAY_CONTROLLER_CLASS}#getOwnerDetails_withAvailableVisitsService` },
    ],
  },
};

/** The visits worker's answer in the real run, word for word: its work finished, `tdd check` refusing every Java test. */
export const IDENTITY_BLOCKED_FINGERPRINT = 'CRITERION_TEST_UNKNOWN:java-full_name-class-prefix-never-matches-declaredAt';

export const FULL_SUITE = ['node', 'tools/surefire.mjs'];

export function vetModules(): Record<string, unknown> {
  return {
    module_defaults: {
      test: ['node', 'tools/surefire.mjs', '-pl', '${MODULE_PATH}'],
      report: { format: 'junit-xml', dir: '${MODULE_PATH}/target/surefire-reports' },
      timeout_seconds: 300,
    },
    modules: [
      { id: 'visits-service', path: VISITS_DIR },
      { id: 'api-gateway', path: GATEWAY_DIR },
    ],
  };
}

export function vetRepository(): RepositoryDecl {
  return { name: 'clinic', path: '../clinic', base_branch: 'main', commands: { test: FULL_SUITE }, ...vetModules() } as RepositoryDecl;
}

export function vetVerifier(module: string): { id: string; module: string; module_sha256: string; command: string[] } {
  return verifierFor(modulesOf(vetRepository()).find((m) => m.id === module) as ResolvedModule);
}

function worker(): Record<string, unknown> {
  return { model: 'sonnet', effort: 'high', max_turns: 40, max_wall_clock_minutes: 60, max_attempts: 2, nested_delegation: false };
}

/** VET-101 as PCM-101's planner graphed it: two producers, a compatibility verification of each module, the candidate. */
export function vetGraph(): Record<string, unknown> {
  const node = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    id,
    level: 'executable-node',
    repository: 'clinic',
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    worker: worker(),
    invalidation_rules: [],
    ...extra,
  });
  return {
    schema_version: 1,
    feature_id: VET_FEATURE,
    title: 'Record which veterinarian handled a visit',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'visits-service: a visit has an optional vet, stored and returned' },
      { id: 'AC-2', text: 'visits-service: a non-positive vet is rejected with 400 and nothing is stored' },
      { id: 'AC-3', text: 'api-gateway: every visit of owner details carries vetId and vetName' },
      { id: 'AC-4', text: 'api-gateway: vetName is null when vets-service fails' },
      { id: 'AC-5', text: 'apart from the new properties, every response keeps its current shape', kind: 'compatibility' },
    ],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['clinic'],
    capabilities: [
      { id: 'CAP-VISITS-VET', repository: 'clinic', title: 'Store and expose the vet of a visit', acceptance_criteria: ['AC-1', 'AC-2', 'AC-5'] },
      { id: 'CAP-GATEWAY-VETNAME', repository: 'clinic', title: 'Show the vet name in owner details', acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] },
    ],
    nodes: [
      node(VISITS_NODE, { capability: 'CAP-VISITS-VET', node_type: 'implementation', depends_on: [], allowed_paths: [`${VISITS_DIR}/**`], required_evidence: ['red', 'green', 'regression'], verification_commands: [vetVerifier('visits-service')], acceptance_criteria: ['AC-1', 'AC-2', 'AC-5'] }),
      node(GATEWAY_NODE, { capability: 'CAP-GATEWAY-VETNAME', node_type: 'implementation', depends_on: [], allowed_paths: [`${GATEWAY_DIR}/**`], required_evidence: ['red', 'green', 'regression'], verification_commands: [vetVerifier('api-gateway')], acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] }),
      node(VISITS_VERIFY, { capability: 'CAP-VISITS-VET', node_type: 'verification', depends_on: [VISITS_NODE, GATEWAY_NODE], allowed_paths: [], required_evidence: ['regression'], verification_commands: [vetVerifier('visits-service')], worker: { ...worker(), effort: 'low', max_turns: 1 }, acceptance_criteria: ['AC-5'] }),
      node(GATEWAY_VERIFY, { capability: 'CAP-GATEWAY-VETNAME', node_type: 'verification', depends_on: [VISITS_NODE, GATEWAY_NODE], allowed_paths: [], required_evidence: ['regression'], verification_commands: [vetVerifier('api-gateway')], worker: { ...worker(), effort: 'low', max_turns: 1 }, acceptance_criteria: ['AC-5'] }),
      {
        id: VET_CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [VISITS_VERIFY, GATEWAY_VERIFY],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', VET_FEATURE] }],
        worker: { ...worker(), max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

export interface Vet {
  root: string;
  control: string;
  repo: string;
  featureDir: string;
}

/** Run the CLI in-process as the controller at `control`. */
export async function vetCli(v: Pick<Vet, 'control'>, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const withAuthority = asController(argv, v.control);
  const code = await main([...withAuthority, '--control-root', v.control], io);
  return { code, out, err };
}

/** The clinic, its control repository with the acceptance review required (as PCM-101's), and the initialised feature. */
export async function createVet(): Promise<Vet> {
  const root = makeTmpDir('vet clinic-');
  const repo = makeGitRepo(join(root, 'clinic'), { files: BASE_FILES });
  const control = join(root, 'control');
  const entry: Record<string, unknown> = {
    name: 'clinic',
    path: relative(control, repo).replace(/\\/g, '/'),
    base_branch: 'main',
    commands: { test: FULL_SUITE },
    tdd: { test_paths: ['*/src/test/**'] },
    ...vetModules(),
  };
  const mycelink = join(process.cwd(), 'bin', 'mycelink.mjs');
  makeGitRepo(control, {
    files: {
      'README.md': '# control\n',
      '.claude/settings.json': JSON.stringify({ hooks: buildHookSettings(mycelink) }, null, 2) + '\n',
      'mycelink.config.json':
        JSON.stringify(
          {
            schema_version: 1,
            claude_executable: join(root, 'no-such-claude'),
            session_adapter: 'claude-background',
            claude_extra_args: [],
            session_timeout_ms: 120000,
            context_pack_max_bytes: 16384,
            hook_session_start_max_bytes: 4096,
            hook_prompt_delta_max_bytes: 2048,
            brain_dir: null,
            acceptance_review: { required: true, max_rounds: 2 },
          },
          null,
          2,
        ) + '\n',
      'repositories.yaml': YAML.stringify({ schema_version: 1, repositories: [entry] }, { lineWidth: 0 }),
    },
  });
  ensureScratchIgnored(control);
  commitAll(control, 'ignore the mycelink scratch area');
  const featureDir = join(control, 'features', VET_FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), `# ${VET_FEATURE} Record which veterinarian handled a visit\n\n- AC-1 visits\n- AC-2 visits\n- AC-3 gateway\n- AC-4 gateway\n- AC-5 compatibility\n`);
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(vetGraph(), { lineWidth: 0 }));
  const v: Vet = { root, control, repo, featureDir };
  const init = await vetCli(v, ['feature', 'init', VET_FEATURE]);
  if (init.code !== 0) throw new Error(`feature init failed: ${init.err}`);
  commitAll(control, 'feature scaffolding');
  return v;
}

export function vetState(v: Vet): Record<string, any> {
  return JSON.parse(readFileSync(join(v.featureDir, 'STATE.json'), 'utf8')).data;
}

export function vetEvents(v: Vet): { type: string; node_id?: string; data: Record<string, any> }[] {
  return readFileSync(join(v.featureDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function commitVetControl(v: Vet, message: string): void {
  if (git(v.control, ['status', '--porcelain']) === '') return;
  commitAll(v.control, message);
}
