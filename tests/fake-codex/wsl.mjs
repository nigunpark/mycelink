import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
writeFileSync(process.env.FAKE_WSL_ARGV, JSON.stringify(argv));
if (argv[0] !== '-d' || argv[2] !== '-u' || argv[4] !== '--' ||
    argv[5] !== '/usr/local/bin/npx' || argv[6] !== '--yes' || argv[7] !== '@openai/codex@0.163.0') process.exit(3);
if (argv[8] === '--version') {
  process.stdout.write('codex-cli 0.163.0\n');
} else {
  const cd = argv.indexOf('--cd');
  const linux = argv[cd + 1];
  if (!/^\/mnt\/[a-z]\//.test(linux)) process.exit(4);
  process.chdir(`${linux[5].toUpperCase()}:${linux.slice(6)}`);
  process.argv = [process.argv[0], process.argv[1], ...argv.slice(8)];
  await import('./codex.mjs');
}
