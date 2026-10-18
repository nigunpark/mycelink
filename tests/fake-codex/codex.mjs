import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.163.0\n'); process.exit(0); }
if (argv[0] !== 'exec' || !argv.includes('--json') || !argv.includes('-') || !argv.includes('--cd') || !argv.includes('--sandbox') || !argv.includes('-c')) process.exit(2);
const prompt = readFileSync(0, 'utf8');
writeFileSync(join(process.cwd(), 'prompt-captured.txt'), prompt);
const scenario = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const pack = JSON.parse(/<mycelink-context-pack>\n([\s\S]*?)\n<\/mycelink-context-pack>/.exec(prompt)[1]);
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'thread.started', thread_id: 'fake' });
emit({ type: 'turn.started' });
if (scenario.stall_ms) await new Promise((done) => setTimeout(done, scenario.stall_ms));
if (scenario.result && !scenario.omit_result) {
  const result = {
    schema_version: 1, node_id: pack.node_id, claim_id: pack.claim_id,
    outcome: scenario.result.outcome, commands: [], evidence_paths: [], ...scenario.result,
  };
  writeFileSync(join(process.cwd(), '.mycelink-worker', 'result.json'), scenario.malformed_result ? '{broken' : JSON.stringify(result));
} else if (scenario.malformed_result) {
  writeFileSync(join(process.cwd(), '.mycelink-worker', 'result.json'), '{broken');
}
if (scenario.failure) emit({ type: 'turn.failed', error: { message: scenario.failure } });
else if (!scenario.omit_completion) emit({ type: 'turn.completed', usage: scenario.usage ?? { input_tokens: 4, output_tokens: 2 } });
process.exit(scenario.exit_code ?? (scenario.failure ? 1 : 0));
