/**
 * Gate command rendering.
 *
 * Regression for the first public Windows CI run: GitHub-hosted runners hand
 * out the temp directory as the 8.3 alias `C:\Users\RUNNER~1\...`, and the
 * orchestrator offers the control root with forward slashes. The `~` made
 * renderGateCommand refuse the line, so every worker attempt failed with
 * WORKER_PROTOCOL_INVALID before it started.
 *
 * A tilde is safe only inside double quotes (bash expands an unquoted one at
 * the start of a word and after `=`), so it must be offered quoted, while
 * everything a shell could still reinterpret stays refused.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGateCommand, WorkerProtocolError } from '../../src/sessions/worker-protocol.js';
import { cleanupTmpRoots, makeTmpDir, windowsShortPathAlias } from '../helpers/tmp.js';

afterAll(() => cleanupTmpRoots());

const RUNNER_CONTROL = 'C:/Users/RUNNER~1/AppData/Local/Temp/mycelink-tests/portfolio-UzY8tj/control';

/** A script that prints its arguments as JSON, at a path every shell accepts. */
function echoArgsScript(): string {
  const file = join(makeTmpDir('gate-echo-'), 'echo-args.mjs');
  writeFileSync(file, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
  return file.replace(/\\/g, '/');
}

/** Shells a worker might run the line in, beyond the platform default. */
function extraShells(): string[] {
  const candidates =
    process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'] : ['/bin/bash', '/bin/sh'];
  return candidates.filter((s) => existsSync(s));
}

function runLine(line: string, shell?: string): string[] {
  const out =
    shell === undefined
      ? execSync(line, { encoding: 'utf8' })
      : execFileSync(shell, ['-c', line], { encoding: 'utf8' });
  return JSON.parse(out) as string[];
}

describe('gate command rendering', () => {
  it('accepts a forward-slash Windows drive path carrying an 8.3 alias, quoted', () => {
    const line = renderGateCommand(['node', 'bin/mycelink.mjs', 'tdd', 'red', '--control-root', RUNNER_CONTROL]);
    expect(line).toBe(`node bin/mycelink.mjs tdd red --control-root "${RUNNER_CONTROL}"`);
  });

  it('never offers a tilde unquoted, where a POSIX shell would expand it', () => {
    for (const arg of ['~', '~/x', 'a=~/x', '--x=~', 'PATH:~/bin', 'RUNNER~1']) {
      expect(renderGateCommand(['node', arg])).toBe(`node "${arg}"`);
    }
  });

  it('passes a real 8.3 alias through every available shell unchanged', (ctx) => {
    const dir = makeTmpDir('gate-long-directory-name-');
    const alias = windowsShortPathAlias(dir);
    if (alias === null) return ctx.skip();
    const target = join(alias, 'control').replace(/\\/g, '/');
    expect(target).toMatch(/^[A-Za-z]:\/.*~\d/);

    const script = echoArgsScript();
    const line = renderGateCommand(['node', script, '--control-root', target, 'a=~/x']);
    expect(runLine(line)).toEqual(['--control-root', target, 'a=~/x']);
    for (const shell of extraShells()) {
      expect(runLine(line, shell), shell).toEqual(['--control-root', target, 'a=~/x']);
    }
  });

  it('keeps the same argv through every available shell for an unquoted-safe tilde path', () => {
    const script = echoArgsScript();
    const line = renderGateCommand(['node', script, RUNNER_CONTROL, '~', 'a=~/x']);
    const expected = [RUNNER_CONTROL, '~', 'a=~/x'];
    expect(runLine(line)).toEqual(expected);
    for (const shell of extraShells()) expect(runLine(line, shell), shell).toEqual(expected);
  });

  it.each([
    '$(whoami)',
    '`id`',
    '$HOME',
    '%OS%',
    'C:/Users/%USERNAME%/x',
    '!x!',
    'a"b',
    "a'b",
    'C:\\Users\\RUNNER~1',
    'a;b',
    'a&b',
    'a|b',
    'a<b',
    'a>b',
    'a^b',
    'a*b',
    'a?b',
    '{a,b}',
    '[ab]',
    '#x',
    'a\nb',
    'a\rb',
    'a\tb',
    'a\u0000b',
  ])('refuses %j, which some shell could reinterpret', (arg) => {
    expect(() => renderGateCommand(['node', arg])).toThrow(WorkerProtocolError);
    expect(() => renderGateCommand(['node', arg])).toThrow(/WORKER_PROTOCOL_INVALID/);
  });

  it('quotes a leading @, which PowerShell would read as splatting', () => {
    expect(renderGateCommand(['node', '@x'])).toBe('node "@x"');
  });

  it('refuses an empty gate command', () => {
    expect(() => renderGateCommand([])).toThrow(/WORKER_PROTOCOL_INVALID/);
  });
});
