/**
 * The launcher answers a request for help as a command-line tool does:
 * `--help`, `-h` and `help`, alone or after a command group, print the usage
 * on stdout and exit 0. No command group, an unknown one, or an unknown flag
 * with no command is a usage error: a non-zero exit (0.2.0-beta.1 through
 * 0.3.0-beta.1's first build exited 1 on `mycelink --help`).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const LAUNCHER = join(resolve(process.cwd()), 'bin', 'mycelink.mjs');
const USAGE = /^mycelink <group> <command> \[options\]\n/;

function mycelink(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('mycelink help', () => {
  it.each([[['--help']], [['-h']], [['help']], [['--help', 'init']], [['init', '--help']], [['feature', '-h']]])('%j prints the usage on stdout and exits 0', (args) => {
    const r = mycelink(...args);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(USAGE);
    expect(r.stdout).toMatch(/^ {2}help \| --help \| -h {2,}print this usage$/m);
    expect(r.stderr).toBe('');
  });

  it('no command group is a usage error: the usage, exit 1', () => {
    const r = mycelink();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(USAGE);
  });

  it('an unknown flag alone is no request for help: exit 1', () => {
    expect(mycelink('--bogus').status).toBe(1);
    expect(mycelink('--help=false').status).toBe(1);
  });

  it('an unknown command group exits 2 and names it', () => {
    const r = mycelink('nonsense');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^Unknown command group "nonsense"\./);
  });
});
