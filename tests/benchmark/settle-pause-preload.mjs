/**
 * Fault injection for the with arm (tests only, loaded by NODE_OPTIONS
 * --import into the session's processes): a `mycelink settle` is held inside
 * the call that moves a worker's result slot into its quarantine — after the
 * rename, before the call returns, so before Mycelink's provenance recorder
 * writes the call's `done` — until the test releases it.
 *
 * MYCELINK_TEST_SETTLE_PAUSE names a directory the test owns. Nothing is held
 * until it holds `arm` (the text a quarantine's path must contain: a node's
 * directory); the first such rename after that writes `paused` (the
 * process and the quarantine) and waits for `release`, two minutes at most
 * (then it writes `expired` and goes on). The preload patches node:fs before
 * Mycelink's recorder captures it, so the recorder sees the held call as one
 * call: its intent written, the slot moved, its done not yet.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const dir = process.env.MYCELINK_TEST_SETTLE_PAUSE;
if (dir && process.argv.slice(2).includes('settle')) {
  const fs = createRequire(import.meta.url)('node:fs');
  const rename = fs.renameSync;
  const slot = /[\\/]\.result-quarantine-[^\\/]+[\\/]slot$/;
  const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let held = false;
  fs.renameSync = function renameSync(from, to) {
    const result = rename.apply(this, arguments);
    if (!held && slot.test(String(to)) && fs.existsSync(join(dir, 'arm')) && String(to).includes(fs.readFileSync(join(dir, 'arm'), 'utf8'))) {
      held = true;
      fs.writeFileSync(join(dir, 'paused'), `${JSON.stringify({ pid: process.pid, quarantine: String(to), at: Date.now() })}\n`);
      const until = Date.now() + 120_000;
      while (!fs.existsSync(join(dir, 'release'))) {
        if (Date.now() > until) {
          fs.writeFileSync(join(dir, 'expired'), '');
          break;
        }
        wait(20);
      }
    }
    return result;
  };
  syncBuiltinESMExports();
}
