# Mycelink public-project benchmark suite

Six change requests on two frozen public projects ask one question: **does
Claude Code deliver a real multi-module change more completely and more
robustly with Mycelink than without it** — judged by an independent,
evaluator-owned verifier the agent never sees.

| PRD | Case | Archetype | Required modules | Change |
|---|---|---|---|---|
| PCM-101 | `petclinic-visit-vet-assignment` | additive vertical slice | visits-service, api-gateway | Record which veterinarian handled a visit |
| PCM-102 | `petclinic-not-found-semantics` | backward-compatible behavioural change | customers-service, api-gateway | Unknown owners and pets answer 404 everywhere |
| PCM-103 | `petclinic-idempotent-visit-booking` | failure / concurrency / recovery | visits-service, api-gateway | Book a visit exactly once, even when requests are retried |
| CSET-201 | `changesets-status-explain` | additive vertical slice | types, assemble-release-plan, cli | `changeset status --explain`: why each package is released |
| CSET-202 | `changesets-aggregated-validation` | backward-compatible behavioural change | errors, read, assemble-release-plan, cli | Report every invalid changeset at once |
| CSET-203 | `changesets-crash-safe-version` | failure / concurrency / recovery | apply-release-plan, cli | Crash-safe `changeset version` |

The projects are frozen at one commit each (see [THIRD_PARTY.md](THIRD_PARTY.md)):

| Project | Commit | Build | Baseline |
|---|---|---|---|
| [spring-petclinic-microservices](https://github.com/spring-petclinic/spring-petclinic-microservices) | `dc9ca15a7118` | Maven 3.9.8 / Java 21, JUnit 5 | 15 tests, 8 modules, every one green |
| [changesets](https://github.com/changesets/changesets) | `c73949ba7b31` | pnpm 11.13.1 / Node 24.14.1, Vitest | 818 tests (816 pass, 2 skipped upstream) |

The multi-module Ledgerline suite (`evals-multimodule/`) is the third project
family; this suite owns only the two public projects and shares no code path
that knows about either of them — each project is an adapter
(`projects/<id>/adapter.json` + `lib/adapters/`).

## Treatment arms

| Arm | Plugin | Faults |
|---|---|---|
| without / normal | no | — |
| with / normal | yes (the sealed release package) | — |
| without / faults | no | fault plan |
| with / faults | yes (the sealed release package) | fault plan |

Pilot runs execute all four arms of a case through one driver,
`tools/run-arm.mjs --matrix`: the same prompt bytes (`lib/cases.mjs`
`casePrompt`: the business request, the test-first delivery rule, and one
availability-conditional sentence that names no Mycelink concept), the same
`claude -p` invocation (`--permission-mode dontAsk --setting-sources user`,
the case's tools, prompt on stdin) but for `--plugin-dir <sealed package>`
in the with arms, the same model, wall-clock and cost caps, the same suite
pin and the same isolation: the sessions' sandboxes differ only by the
plugin's bind in the with arms. `matrix.json` records whether the four runs
match; a mismatch is a confound and the matrix is not trusted. Each run's
verdict keeps the model's delivery apart from the run's evidence:
`verified`; `delivery-failed` (the delivery failed a gate the verdict
required — scope, regression, acceptance, TDD, orchestration, faults —
in an otherwise sound run: a result); or `untrusted` (`trust_problems`: a
session outside a proved boundary, a survivor, evaluator access or plugin
exposure in a transcript, a verdict that is not trusted, broken inputs,
proof of leakage, or a with-arm controller violation whose rollback was not
verified or not attested at the run's end — `controller_rollbacks`: the
manifest the record names, unedited, its snapshots as it names them, no
byte the controller wrote left unless a later session's authorised change
made the same, no commit it made reachable). The run record (`verdict`, `trust`, `delivery`) and
each `matrix.json` entry keep the failures of each kind, the sessions'
summaries (end, exit, turns, cost, confinement, survivors) and the
workers' (node, claim and dispatch, tool calls, TDD gates run, the outcome
they reported and how their submission was settled). Sessions name their phase (the task, or QA's rework of a late defect) and
the session each resumes; `phases` lists each phase's sessions and how it
ended. With arms also record `mycelink` (whether the feature was complete
— every node DONE, and a current candidate whose accepted delivery is
exactly the delivery branch's head, so a candidate a late defect moved the
branch past is stale — histories settle refused, settlements a later
session resumed, a recovered controller key), the same summary per phase as
the phase left it, and `controller`: a phase whose last session exited 0
with the feature incomplete is a controller failure
(`controller:exited-incomplete`, first among the delivery failures),
whatever the verifier finds later. In QA's rework the with arm's session is
the controller alone: its top-level tool calls are scanned as it writes them
(`lib/transcripts.mjs` editScanner), and the first that writes or commits
product code itself — a Write or Edit, a git commit, revert, cherry-pick,
reset, checkout of paths and the like, or a shell write under a registered
repository or one of its worktrees; Mycelink's own CLI, the control
repository, a ticket's result slot, reads, builds and tests aside — stops
the session at once (`ended_by: controller-violation`, its
`controller_edits` recorded) and is a controller failure
(`controller:controller-violation`, naming the call and its transcript
line). A subagent's calls are its own. One lapse gets one correction, on the
phase's own deadline: the harness sets the stopped session's product changes
aside (the delivery branch back where the phase found it, or at a delivery
Mycelink accepted since; its checkout clean; what it set aside kept under
`refs/mycelink-bench/violations/<session>/` and in the session's
`set_aside`), then starts one fresh `rework-corrective` session (`corrects`
names the stopped one) whose prompt is a controller-only header — the first
action is `/mycelink:rework` — then QA's report byte for byte. When that
session and any after it change no product code and the phase ends exited 0
with the feature complete (a new candidate delivered at the branch's head),
the violation is `controller.recovered` (and `delivery.recovered`): kept on
the record, no failure. A second violation, or an incomplete exit, fails the
run; there is no third session. The QA report itself is one text for both
arms: the failing checks, the public module and repository the defect is in
(`affected` on the fault record), then the first action — the plugin's
`/mycelink:rework` when it is available, a direct test-first repair only
when it is not. The
matrix is trusted when it matched and every run's evidence holds; a run is
`ok` only when it is verified as well. Every run gets
a fresh workspace built from the frozen source and a fresh HOME.

The without arms never see the plugin: the package (sealed beside every
run, for its hashes and the verdict) is not bound into their sandbox at all,
so a session cannot stat, read, find or run it, nor start a nested `claude
--plugin-dir` on it; their preflight proves it absent from inside. Each run
record's `plugin_exposure` lists any way a plugin got in anyway: a without
arm whose arguments name `--plugin-dir` or the package, whose sandbox binds
anything at, inside or above it, or one of whose transcripts (the sessions',
the workers', their stderr) names the package or reaches it with a tool,
reports a plugin loaded from a directory at a session's init, or runs a
command that passes `--plugin-dir` (help text, prose or a file the agent
writes that merely mentions the option loads nothing); a with arm that loads
anything but the sealed package, once. Any entry fails the run, and the
matrix.

The generated cases still run under `claude plugin eval` (useful to try a
case), but the harness runs each session as the operator, outside the
isolation boundary: `verify-run --aggregate` marks such runs
`agent_isolation.enforced: false` and `trusted: false`, and they are never
pilot evidence.

## Isolation

Everything that runs agent-controlled code runs inside a
[bubblewrap](https://github.com/containers/bubblewrap) sandbox
(`lib/sandbox.mjs`): agent sessions, and every run of delivered code (the
trusted test runs, the Mycelink CLI on a workspace, fault replays,
qualification and baselines). New user, mount, PID, IPC, UTS, cgroup and
network namespaces; no capabilities; no nested user namespaces; a seccomp
filter refusing AF_VSOCK (on WSL it reaches the Windows host past the network
namespace) and io_uring; `/usr` and `/etc` read-only, private `/tmp`; nothing
else but the bound paths.

An agent session sees its workspace and fresh HOME (writable), the sealed
plugin package (with arms only), the pinned Node (and JDK) on a PATH of its own, and the
claude executable at `/run/bench/bin/claude` (read-only). Inside the HOME, the
private copies of the sealed caches installs copy from — the pnpm content
store (its SQLite index stays writable) and corepack's pinned pnpm — are
read-only too. The suite, the
development checkout, the cache with the evaluator store, the cache pointer,
the evaluator authoring clones, the operator's home and the Windows drives do
not exist inside. Its only network is the model proxy (`lib/model-proxy.mjs`,
reached as `HTTPS_PROXY`): CONNECT to `api.anthropic.com:443` (and any
`--allow-host`), 403 for anything else, every request logged. With a JDK,
every JVM the session or a worker it starts runs gets `-Duser.home=<its
HOME>` (`JAVA_TOOL_OPTIONS`): a JVM takes `user.home` from the passwd entry,
not from `$HOME`, so the Maven wrapper and Maven would look for their
distribution, settings and repository in the operator's `~/.m2` (absent
inside) instead of the HOME's private copies; the run record names the
option (`isolation.profile.jvm_options`). Before the first session, a
preflight runs a probe in exactly that profile and checks all of this from
inside (a JVM's `user.home` and the operator's `~/.m2` included), and that
nothing outlives the sandbox; any failure refuses the run. Processes a
session leaves behind are killed and refuse the run. Trusted test runs get
no network at all.

Every tool that runs such code (`run-arm`, `verify-run`, `qualify`,
`selftest`, `cache verify --baseline`) refuses to run without the boundary
(exit 2). Set up and check a host (Ubuntu under WSL2 here: bubblewrap 0.11.1,
Linux x86_64):

```bash
sudo apt-get install -y bubblewrap python3      # python3: the preflight's AF_VSOCK probe
# Native Ubuntu 24.04+ may restrict unprivileged user namespaces through AppArmor
# (bwrap: "setting up uid map: Permission denied"); allow them for bwrap there.
node evals-public-projects/tools/isolation.mjs check \
  --authoring-root <evaluator authoring clones>   # exit 0: the boundary holds (30 checks for Node, 32 with the JDK)
```

The check runs the same preflight run-arm runs, against this host's real
suite, cache and evaluator store, including a CONNECT to the model API
through the proxy. Runs and verdicts record the boundary they ran in; a
verdict is `trusted` only when every run of delivered code was confined, the
suite was pinned to a clean commit and the qualification exercised another
file system, and a run only when, in addition, every session was confined
after a passing preflight.

## What the agent sees, and what it never sees

```text
README.md           modules, offline build/test commands, environment notes
platform/           coordination Git repository; requirements/<PRD>.md (public),
                    repositories.yaml (the project as Mycelink registers it: test
                    command, test/declaration paths, and for a pnpm project the
                    adapter's exact offline install as worktree_setup)
repos/<project>/    the frozen upstream source (Git, branch main, no remote)
$HOME               private copies of the offline Maven repository / pnpm store
```

Never in a workspace, a case or a commit: the hidden acceptance tests, the
reference solution, the mutants, the expected RED fingerprints and the
qualification details. They live in the evaluator store outside the
repository (`<cache>/evaluator/<project>/<PRD>/`). The repository commits
only `evaluator.lock.json` — one digest over every stored file's path, hash
and size, plus counts per kind, **no file name** — and a counts-only
`qualification.json`. The generated cases (`cases/`) carry the public prompt,
lightweight structural graders and a scaffold; their graders are a proxy, the
verdict is the verifier.

## The verifier (`tools/verify-run.mjs`)

Nothing in the workspace is trusted. The frozen source, the evaluator store
and the baseline are verified against their committed locks before anything
runs; the delivered code runs only in fresh exports with private toolchain
copies. A run is **verified** when every section below passes; TDD gates the
verdict with `--require-tdd`, orchestration with `--require-mycelink`, faults
whenever fault records are given.

| Section | Checks |
|---|---|
| identity | source bundle by content (commit, tree, SHA-256 content digest, history, licenses; the bundle hash is advisory), evaluator store vs lock, baseline record, qualification and its bindings, cache lock, requirement unchanged |
| hygiene | repository on the delivery branch at a committed, clean HEAD; the frozen commit an ancestor; no grafts, replace refs, unsafe git config, symlinks/hardlinks/special files, escaped paths |
| scope | the delivered product (but a path still holding exactly what a bound fault injection gave it) and what each of the delivery's own commits changed (a merge: against every parent) stay in the PRD's allowed modules/shared paths; a production change in every required module; no upstream test deleted |
| leakage | no hidden test, stored evaluator file (reference bundle, mutant, expected.json, fingerprints) or reference test file carrying its author's own tests, in any ref, reflog or file of the workspace and the session HOME; no object store there holding the reference commit; no file at a hidden overlay path. Reference content a delivery converged on (its production, test support that adds no test) is a warning, failing only when the run's transcripts show evaluator access |
| regression | the full trusted suite: every baseline test still passes, nothing fails, new passing tests in every required module that has runtime tests |
| acceptance | the hidden tests overlaid on the delivered HEAD, every one passing |
| tdd | deterministic replay of every red-green unit (below) |
| orchestration | Mycelink evidence: readable state, every node DONE with evidence on disk, `feature verify`/`candidate verify` pass, the candidate binds exactly the delivered HEAD, no leaked lease, no live session, no dirty worker worktree, exactly one current feature |
| faults | every injected commit kept, every replayed settle without a second effect, a restart after an interruption |

### Deterministic TDD replay

The delivered history is split into units (merges split it; a test-only
commit after production code starts a new cycle; injected fault commits are
transparent). A unit with production code is credited only if its leading
commits change tests alone; the tests that delta adds or changes are read
from the files (never from running them); that exact delta applied to the
unit's base makes the trusted command fail **for a missing behaviour**
(assertion, or an exception from the code under test — not syntax, import,
missing symbol, setup, timeout, crash, or not running); and the same test
blobs on the unit's final tree pass with the identical command. Start, RED
and GREEN trees (computed in memory), command, environment and outputs are
hashed into the record. A unit whose production code lies only in modules
the adapter marks `runtime_tests: false` (declarations, documentation; not
a path outside every module) and that changes no test is credited as
`declarations-only`: there is nothing a RED could fail on (CSET-201's
types change, which a Mycelink declaration-only node commits alone). A
delivery still needs at least one runtime unit.

### Qualification (`tools/qualify.mjs`, model-free)

Before any agent runs, each PRD's evaluator artifacts are qualified: the
hidden tests fail on the frozen commit only for missing behaviour (and some
pass — the backward-compatibility checks), pass on the reference in repeated
runs (one with the temp dir on another file system), the reference passes
the full suite with new tests where the work is, replays as test-first and
stays in scope, and every gating mutant builds and is killed in every run —
with at least one in every required module that has runtime behaviour.
`qualification.json` records the counts.

### Faults (`lib/faults.mjs`, `fault-plans/default.json`)

| Fault | Injection | Verified |
|---|---|---|
| concurrent-commit | at the agent's first commit, a teammate commit lands on the delivery branch (compare-and-swap; the agent's working tree is kept) | the delivery contains it (no lost update) |
| interrupt-restart | after 600 s the running session's process group is killed (the task's or QA's rework's); a fresh session of that phase resumes with a fixed header plus that phase's prompt, on the phase's own budget, until a session ends on its own | the record names the interrupted session and the fresh session of its phase that resumed it; the delivery is judged as usual |
| late-hidden-defect | after the delivery, a commit reverts the delivered production change of the first required module with runtime tests; QA reports the hidden checks that now fail; a fresh session repairs it (through Mycelink's node rework when the plugin is available, directly test-first when not: one prompt for both arms) | the defect commit stays in history; acceptance passes again |
| duplicate-result, stale-result | (Mycelink only) the last / first settle capability seen in the transcripts is replayed; never one that still holds a live claim | refused or answered from Mycelink's stored receipt, with the feature state unchanged apart from write bookkeeping |

Injected commits are nobody's TDD cycle, and their effect is not the
delivered scope. The TDD replay sees through exactly the commits a record
binds (parent, tree, changes, identity, binding hash), whatever later
commits do to their content, and the late defect, which lands after the
delivery, also ends the cycles before it: QA's repair replays as cycles of
its own, so a repair that reverts the defect before any test fails on its
own commits, never on the delivered cycle it follows. An injection the
delivered history no longer holds (amended, replaced, dropped) or a record
that no longer binds fails the replay (`tdd.injections`); a commit that only
looks like one (author, message, paths) is the delivery's. Scope is
stricter: a path is left out only while the delivered tree holds exactly the
content a bound commit gave it (a teammate's note an integration merge
brought in). An edit of it, even one a later commit reverts, or an injected
commit dropped or rewritten, is the delivery's again; a repaired late defect
is judged by the repair. A fault whose
trigger never fired, or that does not apply (the Mycelink-only faults in
the `without` arm), is recorded and reported as a warning.

## Runbook

Run everything on the Linux/WSL host that runs the evals, with Java 21,
Node 24.14.1, Git and bubblewrap installed, and a Git identity exported
(`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
`GIT_COMMITTER_EMAIL`). The suite must be a clean checkout: run-arm and
verify-run pin it to its commit (`--expect-suite-commit` to insist on one)
and read the committed tree, sealed.

```bash
# 0. The isolation boundary (see Isolation).
node evals-public-projects/tools/isolation.mjs check --authoring-root <authoring clones>

# 1. Sources (online once, re-made from the public remotes and checked by content), caches, baselines.
node evals-public-projects/tools/source.mjs prepare --project changesets --online      # and spring-petclinic-microservices
node evals-public-projects/tools/cache.mjs prepare --java-home "$JAVA_HOME" --node-bin "$(dirname "$(command -v node)")" --online
node evals-public-projects/tools/cache.mjs verify --baseline

# 2. Evaluator artifacts (from the evaluator's authoring clones, or an exported archive; never committed),
#    then qualification with a temp root on another file system (here: tmpfs vs the ext4 work dir).
node evals-public-projects/tools/evaluator.mjs import --prd PCM-101 --from <authoring clone>   # each PRD
node evals-public-projects/tools/evaluator.mjs import-archive --prd PCM-101 --archive <export.zip>   # or this
node evals-public-projects/tools/qualify.mjs --prd PCM-101 --work-dir <dir on ext4> --tmp-root /dev/shm/bench-qualify

# 3. Cases and the model-free selftest (~30 min, most of it Maven; it also proves every scaffold
#    finishes within 90 s of the harness's 120 s kill).
node evals-public-projects/tools/generate-cases.mjs --check
node evals-public-projects/tools/selftest.mjs          # npm run bench:selftest

# 4. The pilot (model usage): the four arms of each case, confined, matched; run dirs default to the OS temp dir.
node evals-public-projects/tools/run-arm.mjs --case PCM-101 --matrix \
  --faults evals-public-projects/fault-plans/default.json --require-mycelink --authoring-root <authoring clones>
```

Run directories may not lie inside the suite, the checkout, the cache, a
toolchain or an authoring clone (refused). Sessions start from an empty HOME
and need model access in the environment (`ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`); a Bedrock or Vertex endpoint needs
`--allow-host <host:port>`.

## Caveats and known limitations

- **Changesets baseline.** The suite is the upstream root Vitest suite,
  which upstream itself runs without `scripts/e2e` (own workspace and
  dependency set, never installed by `pnpm bootstrap`); that exclusion is
  recorded with its evidence in the adapter. Nothing else is excluded or
  patched. The 2 skipped tests are skipped upstream.
- **Changesets build mutation.** `pnpm build` rewrites
  `packages/config/package.json` (valibot 1.4.2 → 1.5.0) on every build of the
  frozen commit. The workspace guide tells the agent not to commit it; a
  delivery that commits exactly that rewrite is tolerated with a warning.
- **Determinism pins.** Tests run with `TZ=UTC`, `LANG=C.UTF-8`, `CI=1`,
  `NO_COLOR=1`, corepack's pinned pnpm (`lastKnownGood.json`) with network
  disabled, and a blackholed npm registry. The frozen Changesets workspace sets
  pnpm's `minimumReleaseAge` and `trustPolicy`, which fetch registry
  metadata even for an offline, frozen-lockfile install (unconfined, that
  silently used the network; inside the sandbox it stalls for ~25 min and
  fails): trusted runs and the scaffold set `pnpm_config_minimum_release_age=0`
  and `pnpm_config_trust_policy=off`; the lockfile and store integrity checks
  stay on. An agent that reinstalls inside its sandbox meets the same
  stall unless it sets them. Hidden Changesets tests compare
  plans order-independently, because the order in which changesets are read
  from disk differs between file systems (ext4 vs tmpfs); qualification runs
  once with the temp dir on another file system to catch such dependencies.
- **Declarations-only module.** `@changesets/types` contains only TypeScript
  declarations. CSET-201 requires its production change, but no runtime test
  can be added there; the adapter marks it `runtime_tests: false`, and the
  late defect never targets it.
- **Worktree dependencies.** A git worktree does not carry the base
  checkout's untracked `node_modules` (CSET-201 r1: every Mycelink node
  worktree had none, and the types node's `pnpm build` exited 127). The
  generated `platform/repositories.yaml` gives Changesets the adapter's
  install argv, verbatim, as `worktree_setup` (store and corepack from the
  session HOME via `${HOME}`); the base checkout is installed by exactly the
  same command. Petclinic needs none (Maven reads `~/.m2` from every
  checkout). The guide names the install; the with arm's verdict checks the
  registered setup and every node's setup receipt against the generated one
  (`orchestration: worktree-setup`).
- **PCM-103.** The shared-database test cannot distinguish idempotency
  state held in a JVM-static map from state in the database, because both
  service instances run in one JVM; the other PCM-103 checks (conflicts,
  concurrency, retries through the gateway) are unaffected.
- **Windows.** There is no isolation boundary on Windows: every tool that
  runs agent or delivered code refuses there (the CI-safe tests use an
  explicit, unenforced stand-in and are never trusted). Run under WSL/Linux.
- **What an agent could read.** Inside the boundary, nothing of the suite,
  the checkout, the caches or the evaluator store; the transcript scan of
  every session and worker for those roots is defense in depth
  (`lib/transcripts.mjs`). It reads Bash calls as a shell would
  (`lib/shell.mjs`: quotes, escapes, variables, `cd`, globs, nested shells
  and substitutions) and the file tools' path fields; a heredoc a command
  writes, a script it feeds to an interpreter, a comment or a Write's
  content is data — only a forbidden root named literally in it counts.
  Recursive tools pointed above a root (`find /`) are recorded as probes
  and fail nothing. Sessions run by `claude plugin eval` are not confined
  and are never pilot evidence.
- **Convergence on the reference.** An independent delivery can write a
  file byte for byte as the reference did when the requirement and the
  upstream conventions dictate it: the PCM-101 pilot's isolated without arm
  wrote the record, both seed SQL files and the mock bean the reference
  wrote. Such content is reported (`reference-convergence`, a warning) and
  never proves leakage by itself; proof is what no independent delivery can
  produce — a hidden test, a stored evaluator file, the reference's commits,
  or a reference test file with tests its author added. The verifier reads
  the convergence as leakage only when the run's transcripts show evaluator
  access.
- **Disclosure in the fault arm.** QA's late-defect report names the hidden
  checks that fail after the injected regression (and their first message
  line), the same way in both orchestration arms. What it asks next is one
  text for both arms (`REWORK_INSTRUCTION`), conditional on the plugin as the
  request's own instruction is: with Mycelink, never edit or commit product
  code in the session, attribute the checks to the producer node, `node
  rework` it with them as the reason, dispatch, settle, cut and deliver a new
  candidate, and finish only once `feature verify --delivered` passes;
  without it, repair directly, test-first, on the delivery branch.
- **Exposure.** A run that ends before 600 s is never interrupted; its
  `interrupt-restart` record says so, and comparisons should count only
  applied faults. The trigger counts from the run's start, so it can land
  in either phase; a plan can scope a mid-session trigger to one phase
  (`"phase": "rework"`) to interrupt both arms at the same point of it.

## Files

```text
projects/<id>/adapter.json         topology, commands, environment, toolchain, exclusions
projects/<id>/source.lock.json     frozen source identity (remote, commit, tree, content digest, history, licenses; advisory bundle hash)
projects/<id>/baseline-tests.json  every upstream test the trusted command reports, with its status
projects/<id>/prds/<PRD>/          case.json, requirement.md, evaluator.lock.json, qualification.json
schemas/                           JSON schemas of every manifest and record
cases/                             generated eval cases (tools/generate-cases.mjs)
fault-plans/                       evaluator fault plans
lib/                               verifier, adapters, TDD replay, faults, arms, qualification, selftest, sandbox,
                                   agent isolation (preflight, probe, launcher, model proxy), suite pin
tools/                             source, cache, evaluator, qualify, generate-cases, scaffold, isolation,
                                   verify-run, run-arm (--matrix), selftest
```

The CI-safe tests (`tests/benchmark/`, part of `npm test`) prove the harness
on a tiny two-module toy project, including a genuine Mycelink delivery and
its rejection under every orchestration mutation; `tools/selftest.mjs`
proves it on the real projects.
