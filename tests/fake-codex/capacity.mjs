// Native Node child: no shell, prompt capture, result slot, or worktree writes.
import { readFileSync } from 'node:fs';
const lines = JSON.parse(readFileSync(process.env.FAKE_CODEX_CAPACITY_LINES, 'utf8'));
readFileSync(0, 'utf8');
for (const line of lines) process.stdout.write(line + '\n');
process.exitCode = 1;
