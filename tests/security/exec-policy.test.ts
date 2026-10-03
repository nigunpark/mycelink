/**
 * Command execution policy.
 *
 * Repository and verification commands are argv arrays executed without a
 * shell. Shell mode exists, but only when a verification command asks for it
 * explicitly AND the control repository's own configuration allows it: a
 * graph (which may be model-written) can never turn a shell on by itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CommandPolicyError,
  planCommand,
  runCommandSync,
  validateArgv,
} from '../../src/security/exec.js';
import { runVerification } from '../../src/evidence/runner.js';
import { DEFAULT_CONFIG } from '../../src/workspace/workspace.js';
import { validateGraph } from '../../src/graph/validate.js';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

afterEach(() => cleanupTmpRoots());

const node = process.execPath;

describe('argv validation', () => {
  it.each([
    [[], 'EMPTY_COMMAND'],
    [[''], 'EMPTY_EXECUTABLE'],
    [['-rf', '/'], 'OPTION_AS_EXECUTABLE'],
    [['node\nrm'], 'CONTROL_CHARACTER'],
    [['node', 'a\u0000b'], 'NUL_BYTE'],
  ])('rejects %j as %s', (argv, code) => {
    expect(() => validateArgv(argv as string[])).toThrow(CommandPolicyError);
    try {
      validateArgv(argv as string[]);
    } catch (err) {
      expect((err as CommandPolicyError).code).toBe(code);
    }
  });
});

describe('argv mode never involves a shell', () => {
  it('passes shell metacharacters through as literal argument text', () => {
    const marker = makeTmpDir('exec-');
    const payload = `x; node -e "require('fs').writeFileSync('pwned','')" && echo INJECTED | more & echo %PATH% $(id)`;
    const r = runCommandSync([node, '-e', 'process.stdout.write(process.argv[1])', payload], {
      cwd: marker,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(payload);
    expect(existsSync(join(marker, 'pwned'))).toBe(false);
  });

  it('treats a configured executable containing shell syntax as a file name, not a script', () => {
    const marker = makeTmpDir('exec-');
    const r = runCommandSync([`node -e "require('fs').writeFileSync('pwned','')"`], { cwd: marker });
    expect(r.exitCode).toBe(127);
    expect(existsSync(join(marker, 'pwned'))).toBe(false);
  });
});

describe('explicit shell mode', () => {
  it('is refused unless the control-repo configuration allows it', () => {
    expect(DEFAULT_CONFIG.allow_shell_commands).toBe(false);
    expect(() => planCommand(['echo a && echo b'], { shell: true, allowShell: false })).toThrow(
      /SHELL_NOT_ALLOWED/,
    );
  });

  it('requires exactly one script element', () => {
    expect(() => planCommand(['echo', 'a'], { shell: true, allowShell: true })).toThrow(
      /SHELL_SCRIPT_SHAPE/,
    );
  });

  it('runs through the platform shell when allowed', () => {
    const r = runCommandSync(['echo first&& echo second'], { cwd: makeTmpDir('exec-'), shell: true, allowShell: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/first/);
    expect(r.stdout).toMatch(/second/);
  });

  it('a graph may declare shell: true, but verification still refuses it under the default config', () => {
    const g = clone(VALID_GRAPH);
    const v = (g.nodes[0] as { verification_commands: Record<string, unknown>[] }).verification_commands[0] as Record<string, unknown>;
    v['shell'] = true;
    v['command'] = ['echo hi && echo there'];
    expect(validateGraph(g).ok).toBe(true);

    const dir = makeTmpDir('exec-');
    expect(() =>
      runVerification({
        kind: 'green',
        nodeId: 'FEAT-101.core.publish.impl',
        repository: 'core',
        command: ['echo hi && echo there'],
        shell: true,
        allowShell: DEFAULT_CONFIG.allow_shell_commands,
        cwd: dir,
        evidenceDir: join(dir, 'evidence'),
      }),
    ).toThrow(CommandPolicyError);
  });
});

describe('Windows batch shims (npm.cmd, yarn.cmd, ...)', () => {
  const resolveCmd = (): string => 'C:\\tools\\nodejs\\npm.cmd';

  it('runs a batch shim through cmd.exe with each argument quoted', () => {
    const plan = planCommand(['npm', 'test', '--', 'my filter'], {
      platform: 'win32',
      resolveExecutable: resolveCmd,
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    expect(plan.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe('""C:\\tools\\nodejs\\npm.cmd" "test" "--" "my filter""');
  });

  it.each(['a&calc', 'a|b', 'a>b', 'a<b', 'a^b', 'a"b', '%PATH%', '!x!', 'a\nb', 'trailing\\'])(
    'refuses argument %j that cmd.exe would reinterpret',
    (arg) => {
      expect(() =>
        planCommand(['npm', 'test', arg], { platform: 'win32', resolveExecutable: resolveCmd, env: {} }),
      ).toThrow(/BATCH_METACHARACTER/);
    },
  );

  it('spawns a real .exe directly without cmd.exe', () => {
    const plan = planCommand(['git', 'status'], {
      platform: 'win32',
      resolveExecutable: () => 'C:\\Program Files\\Git\\cmd\\git.exe',
      env: {},
    });
    expect(plan.file).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(plan.args).toEqual(['status']);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it('on POSIX, argv is passed through untouched', () => {
    const plan = planCommand(['npm', 'test', 'a&b'], { platform: 'linux', env: {} });
    expect(plan).toMatchObject({ file: 'npm', args: ['test', 'a&b'], shell: false });
  });
});
