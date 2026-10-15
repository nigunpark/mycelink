#!/usr/bin/env node
/**
 * docs/assets/quickstart-demo.gif and its still, docs/assets/quickstart-demo-static.png: the quickstart's
 * scripted walkthrough played back in about a minute.
 *
 *   node scripts/quickstart-demo-gif.mjs [--browser <chrome or edge>] [--ffmpeg <ffmpeg>] [--frames <dir>] [--out <dir>]
 *   node scripts/quickstart-demo-gif.mjs --plan      print the scene plan as JSON (no browser, no ffmpeg)
 *
 * The source is examples/quickstart/SAMPLE-OUTPUT.md, which tests/fixtures/quickstart-walkthrough.test.ts holds
 * equal to what `node examples/quickstart/walkthrough.mjs` prints: the real controller, Git and gates driven by a
 * scripted module-worker and acceptance reviewer, with the AC-4 gap planted on purpose. It is never a model run,
 * and every frame says so (LABEL). Each terminal line in a frame is one of the sample's lines, verbatim and in
 * order; every line is shown. The status chips are read from those lines only (statusAfter).
 *
 * Each scene is a local HTML page (no remote asset, no script) that a headless Chromium browser renders to a PNG;
 * ffmpeg joins the PNGs, each held for its scene's duration, into one GIF with one palette. Nothing reads the
 * clock or a random source, so the same sample, browser, fonts and ffmpeg give byte-identical files.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE = join(ROOT, 'examples', 'quickstart', 'SAMPLE-OUTPUT.md');
export const GIF = 'quickstart-demo.gif';
export const STILL = 'quickstart-demo-static.png';
export const LABEL = 'SCRIPTED WALKTHROUGH · NO MODEL';
export const WIDTH = 1040;
export const HEIGHT = 650;

/** The walkthrough's output: the sample's text block, line by line. */
export function sampleLines(text = readFileSync(SAMPLE, 'utf8')) {
  const block = /```text\n([\s\S]*?)\n```/.exec(text.replace(/\r\n/g, '\n'))?.[1];
  if (block === undefined) throw new Error('SAMPLE-OUTPUT.md has no text block');
  return block.split('\n');
}

/** Each terminal scene shows the lines up to the first one at or after the previous scene's end that matches `through`. */
const STEPS = [
  { through: /^Scripted worker and reviewer, no model/, ms: 2600, caption: 'One feature, ORD-101, across two independent Git repositories. Scripted worker and reviewer; no model.' },
  { through: /^\[setup\] +acceptance probe on the baselines: 0\/4/, ms: 3200, caption: 'Each repository has its own .git and main. The feature does not exist yet: the acceptance probe passes 0 of 4.' },
  { through: /^\[plan\] +READY /, ms: 3200, caption: 'The graph validates. Only the API node is READY: the web node waits for the contract’s producer.' },
  { through: /^\[dispatch\] +ORD-101\.api\./, ms: 2200, caption: 'The controller dispatches the API node into its own worktree and wip/ branch.' },
  { through: /^\[commit\] +api: \S+ tests only/, ms: 3200, caption: 'Test first: the RED must fail for the missing behaviour. The tests are committed alone.' },
  { through: /^\[settle\] +ORD-101\.api\./, ms: 3400, caption: 'GREEN reruns the identical command, the full suite passes, and settle re-verifies on a clean checkout.' },
  { through: /^\[commit\] +web: \S+ tests only/, ms: 2600, caption: 'Only now is the web node dispatched, in its own repository and worktree, with its own RED.' },
  { through: /^\[settle\] +ORD-101\.web\./, ms: 2400, caption: 'Both nodes are DONE. That is not acceptance yet.' },
  { through: /^\[review\] +ORD-101-R001: independent/, ms: 2400, caption: 'An independent, read-only reviewer judges all four criteria against both exact SHAs.' },
  { through: /^\[rework\] +ORD-101\.web\.status\.impl reopened/, ms: 4200, caption: 'Planted fault: the reviewer finds an untested AC-4 clause. Only the owning node reopens; no candidate is cut.' },
  { through: /^ +failed +a payload without a status/, ms: 2800, caption: 'The rework carries the reviewer’s brief and starts with a new RED that reproduces the gap.' },
  { through: /^\[settle\] +ORD-101\.web\./, ms: 2800, caption: 'The rework settles DONE. AC-3’s proof carries over from the earlier RED.' },
  { through: /^\[review\] +ORD-101-R002: PASS/, ms: 2600, caption: 'A second review: PASS on every criterion.' },
  { through: /^\[candidate\] /, ms: 3600, caption: 'One immutable candidate binds the exact SHA of both repositories.' },
  { through: /^\[deliver\] +orders-web main/, ms: 4000, caption: 'Delivery fast-forwards main in both repositories to exactly those SHAs. Nothing is pushed.' },
  { through: /^Done: /, ms: 4200, caption: 'The acceptance probe passes 4 of 4 on the delivered commits. 0 model calls: this is the scripted walkthrough.' },
];
const TITLE_MS = 3600;
const END_MS = 4400;

/** The chips over the terminal, in order. */
export const CHIPS = [
  ['api', 'orders-api node'],
  ['web', 'orders-web node'],
  ['review', 'Acceptance review'],
  ['candidate', 'Candidate'],
  ['delivery', 'Delivery'],
  ['probe', 'AC probe'],
];

/** What the shown lines say about each chip; a chip no line has spoken for yet is '—'. */
export function statusAfter(shown) {
  const s = Object.fromEntries(CHIPS.map(([key]) => [key, '—']));
  for (const line of shown) {
    const tag = /^\[([a-z]+)\] +(.*)$/.exec(line);
    if (tag === null) continue;
    const [, kind, text] = tag;
    const node = /^(?:ORD-101\.)?(api|web)[.:]/.exec(text)?.[1];
    if (kind === 'plan' && /graph valid/.test(text)) s.api = s.web = 'PLANNED';
    else if (kind === 'plan' && /^READY ORD-101\.api\./.test(text)) s.api = 'READY';
    else if (kind === 'setup' && /probe on the baselines: (\d\/\d)/.test(text)) s.probe = `${/(\d\/\d)/.exec(text)[1]} on baselines`;
    else if (kind === 'dispatch' && node) s[node] = 'DISPATCHED';
    else if (kind === 'dispatch' && /^ORD-101-(R\d+)/.test(text)) s.review = `${/^ORD-101-(R\d+)/.exec(text)[1]} DISPATCHED`;
    else if (kind === 'red' && node) s[node] = 'RED accepted';
    else if (kind === 'green' && node) s[node] = 'GREEN';
    else if (kind === 'result' && node) s[node] = 'SUBMITTED';
    else if (kind === 'settle' && node && /: DONE/.test(text)) s[node] = 'DONE';
    else if (kind === 'review' && /^ORD-101-(R\d+): GAP (AC-\d+)/.test(text)) {
      const [, id, ac] = /^ORD-101-(R\d+): GAP (AC-\d+)/.exec(text);
      s.review = `${id} GAP ${ac}`;
    } else if (kind === 'review' && /^ORD-101-(R\d+): PASS/.test(text)) {
      s.review = `${/^ORD-101-(R\d+)/.exec(text)[1]} PASS`;
      s.candidate = '—';
    } else if (kind === 'rework' && /^ORD-101\.(api|web)\.\S+ reopened/.test(text)) {
      s[/^ORD-101\.(api|web)/.exec(text)[1]] = 'REOPENED';
      s.candidate = 'refused: gap open';
    } else if (kind === 'candidate' && /^ORD-101-(C\d+): immutable/.test(text)) s.candidate = `${/^ORD-101-(C\d+)/.exec(text)[1]} immutable`;
    else if (kind === 'deliver' && /^ACCEPTED /.test(text)) s.delivery = 'ACCEPTED';
    else if (kind === 'verify' && /probe on the delivered commits: (\d\/\d)/.test(text)) s.probe = `${/commits: (\d\/\d)/.exec(text)[1]} delivered`;
  }
  return s;
}

/** Title card, one terminal scene per step (which together show every line), end card. */
export function demoScenes(lines = sampleLines()) {
  const scenes = [{ kind: 'title', ms: TITLE_MS }];
  let next = 0;
  let before = statusAfter([]);
  for (const step of STEPS) {
    const at = lines.findIndex((line, i) => i >= next && step.through.test(line));
    if (at < 0) throw new Error(`No sample line at or after line ${next + 1} matches ${step.through}`);
    const status = statusAfter(lines.slice(0, at + 1));
    const changed = CHIPS.map(([key]) => key).filter((key) => status[key] !== before[key] && status[key] !== '—');
    scenes.push({ kind: 'terminal', ms: step.ms, caption: step.caption, shown: at + 1, fresh: at + 1 - next, status, changed });
    before = status;
    next = at + 1;
  }
  if (next !== lines.length) throw new Error(`The scenes show ${next} of the sample's ${lines.length} lines`);
  scenes.push({ kind: 'end', ms: END_MS });
  // ffmpeg's concat demuxer times a still image in steps of 1/25 s; any other duration would be rounded.
  const uneven = scenes.filter((s) => s.ms % 40 !== 0);
  if (uneven.length > 0) throw new Error(`Scene durations must be multiples of 40 ms: ${uneven.map((s) => s.ms).join(', ')}`);
  return scenes;
}

// ---- one scene as an HTML page ------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TAG_CLASS = { setup: 'dim', plan: 'dim', dispatch: 'blue', red: 'red', commit: 'violet', green: 'green', regress: 'green', result: 'blue', settle: 'green', review: 'amber', rework: 'amber', controller: 'green', candidate: 'green', deliver: 'green', verify: 'green' };

function lineHtml(line, fresh) {
  const cls = fresh ? 'ln fresh' : 'ln';
  const tag = /^(\[([a-z]+)\] *)(.*)$/.exec(line);
  if (tag) {
    let tone = TAG_CLASS[tag[2]] ?? 'dim';
    if (tag[2] === 'review' && /: PASS/.test(tag[3])) tone = 'green';
    return `<div class="${cls}"><span class="tag ${tone}">${esc(tag[1])}</span>${esc(tag[3])}</div>`;
  }
  if (/^ +failed /.test(line)) return `<div class="${cls} sub red-dim">${esc(line)}</div>`;
  return `<div class="${cls} plain">${line === '' ? '&nbsp;' : esc(line)}</div>`;
}

function tone(value) {
  if (value === '—') return 'idle';
  if (/GAP|REOPENED|refused/.test(value)) return 'warn';
  if (/^RED/.test(value)) return 'red';
  if (/DONE|PASS|immutable|ACCEPTED|4\/4/.test(value)) return 'ok';
  return 'info';
}

const STYLE = `*{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0b0f0d;color:#e8efe9;font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif}
.frame{display:flex;flex-direction:column;width:100%;height:100%;padding:14px 18px 14px}
.top{display:flex;align-items:center;justify-content:space-between;height:34px}
.label{background:#f5b942;color:#1b1406;font:800 15px/1 Consolas,"Cascadia Mono",monospace;letter-spacing:.06em;padding:8px 12px;border-radius:6px}
.title{color:#9fb0a6;font-size:15px}.title b{color:#e8efe9}
.chips{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:10px 0 10px}
.chip{border:1px solid #2b3830;background:#111814;border-radius:8px;padding:7px 9px 8px;min-width:0}
.chip .k{color:#8a9a90;font-size:12px;letter-spacing:.02em}
.chip .v{font:700 14px/1.25 Consolas,"Cascadia Mono",monospace;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip.idle .v{color:#5d6b63}.chip.info .v{color:#79c0ff}.chip.ok .v{color:#56d88f}.chip.warn .v{color:#f5b942}.chip.red .v{color:#ff7b72}
.chip.changed{border-color:#56d88f;box-shadow:0 0 0 1px #56d88f inset}.chip.changed.warn{border-color:#f5b942;box-shadow:0 0 0 1px #f5b942 inset}.chip.changed.red{border-color:#ff7b72;box-shadow:0 0 0 1px #ff7b72 inset}
.term{position:relative;flex:1;min-height:0;border:1px solid #2b3830;border-radius:10px;background:#070a08;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:10px 14px 10px}
.term:before{content:"";position:absolute;left:0;right:0;top:0;height:46px;background:linear-gradient(#070a08,rgba(7,10,8,0));z-index:2}
.ln{font:15px/21px Consolas,"Cascadia Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding-left:13ch;text-indent:-13ch;color:#c9d4cd;border-left:3px solid transparent;margin-left:-8px;padding-right:4px}
.ln.sub{padding-left:15ch;text-indent:-15ch}
.ln.fresh{background:rgba(86,216,143,.09);border-left-color:#56d88f;color:#f1f6f2}
.tag{white-space:pre}.dim{color:#8a9a90}.blue{color:#79c0ff}.red{color:#ff7b72}.red-dim{color:#e7958f}.violet{color:#d2a8ff}.green{color:#56d88f}.amber{color:#f5b942}
.cap{display:flex;align-items:center;justify-content:space-between;gap:16px;height:62px;margin-top:10px;padding:0 4px 0 14px;border-left:4px solid #56d88f}
.cap .t{font-size:20px;line-height:1.3;font-weight:600;color:#f1f6f2}
.card{flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 46px}
.card .big{align-self:flex-start;background:#f5b942;color:#1b1406;font:800 30px/1 Consolas,"Cascadia Mono",monospace;letter-spacing:.06em;padding:14px 18px;border-radius:8px}
.card h1{font-size:40px;line-height:1.12;margin:30px 0 14px;letter-spacing:-.02em}
.card p{font-size:20px;line-height:1.45;color:#b8c5bd;margin:0 0 10px;max-width:900px}
.card code{font:17px Consolas,"Cascadia Mono",monospace;color:#7ff0af;background:#111814;border:1px solid #2b3830;border-radius:6px;padding:3px 8px}
.card .cmd{margin:8px 0;font-size:18px;color:#b8c5bd}.card .cmd code{margin-right:10px}`;

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${WIDTH},height=${HEIGHT},initial-scale=1"><style>${STYLE}</style></head><body><main class="frame">${body}</main></body></html>`;
}

const TOP = `<div class="top"><span class="label">${LABEL}</span><span class="title"><b>Mycelink quickstart</b> · ORD-101 · two independent Git repositories</span></div>`;

/** The scene's page: every one carries LABEL. */
export function frameHtml(scene, lines = sampleLines()) {
  if (scene.kind === 'title') {
    return page(`<section class="card"><span class="big">${LABEL}</span>
<h1>One feature across two independent Git repositories</h1>
<p>The Mycelink quickstart, ORD-101: the real controller, Git and TDD gates, driven by a <b>scripted</b> worker and reviewer.</p>
<p>The review gap on AC-4 is planted on purpose. No model is called, and the pace is set for reading, not measured.</p>
<p class="cmd"><code>node examples/quickstart/walkthrough.mjs</code></p></section>`);
  }
  if (scene.kind === 'end') {
    return page(`<section class="card"><span class="big">${LABEL}</span>
<h1>Run it yourself</h1>
<p class="cmd"><code>node examples/quickstart/setup.mjs --out ../mycelink-quickstart</code></p>
<p class="cmd"><code>node examples/quickstart/walkthrough.mjs</code> this replay, no model</p>
<p class="cmd"><code>/mycelink:run ORD-101</code> a real Claude Code run; it uses model quota</p>
<p style="margin-top:22px">A real model run of this demo is reported separately, with its own SHAs:<br><code>docs/evals/2026-10-15-public-two-repo-demo.md</code></p></section>`);
  }
  const chips = CHIPS.map(([key, name]) => {
    const value = scene.status[key];
    return `<div class="chip ${tone(value)}${scene.changed.includes(key) ? ' changed' : ''}"><div class="k">${esc(name)}</div><div class="v">${esc(value)}</div></div>`;
  }).join('');
  const shown = lines.slice(0, scene.shown).map((line, i) => lineHtml(line, i >= scene.shown - scene.fresh)).join('');
  return page(`${TOP}<div class="chips">${chips}</div><div class="term">${shown}</div><div class="cap"><span class="t">${esc(scene.caption)}</span></div>`);
}

// ---- rendering ------------------------------------------------------------------

function findBrowser() {
  const env = process.env;
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}:\n${r.stderr}`);
  return r;
}

function render(browser, html, png, profile) {
  run(browser, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${WIDTH},${HEIGHT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    `--screenshot=${png}`,
    pathToFileURL(html).href,
  ]);
  if (!existsSync(png)) throw new Error(`${browser} wrote no screenshot for ${html}`);
}

function parseArgs(argv) {
  const opts = { browser: null, ffmpeg: process.env.FFMPEG ?? 'ffmpeg', frames: null, out: join(ROOT, 'docs', 'assets'), plan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') opts.plan = true;
    else if (['--browser', '--ffmpeg', '--frames', '--out'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = resolve(v);
    } else throw new Error(`Unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lines = sampleLines();
  const scenes = demoScenes(lines);
  if (opts.plan) {
    process.stdout.write(`${JSON.stringify({ width: WIDTH, height: HEIGHT, frames: scenes.length, ms: scenes.reduce((n, s) => n + s.ms, 0), scenes }, null, 2)}\n`);
    return;
  }
  const browser = opts.browser ?? findBrowser();
  if (browser === null) throw new Error('No Chrome, Chromium or Edge found; pass --browser <path>');
  const work = mkdtempSync(join(tmpdir(), 'mycelink-demo-gif-'));
  try {
    const frames = opts.frames ?? join(work, 'frames');
    mkdirSync(frames, { recursive: true });
    const list = ['ffconcat version 1.0'];
    scenes.forEach((scene, i) => {
      const name = `frame-${String(i).padStart(2, '0')}`;
      const html = join(work, `${name}.html`);
      writeFileSync(html, frameHtml(scene, lines));
      render(browser, html, join(frames, `${name}.png`), join(work, 'profile'));
      list.push(`file '${join(frames, `${name}.png`).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`, `duration ${(scene.ms / 1000).toFixed(2)}`);
    });
    writeFileSync(join(work, 'frames.ffconcat'), `${list.join('\n')}\n`);
    mkdirSync(opts.out, { recursive: true });
    const last = scenes[scenes.length - 1];
    run(opts.ffmpeg, [
      '-v', 'error', '-y', '-nostdin',
      '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.ffconcat'),
      '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=96:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      '-fps_mode', 'vfr', '-loop', '0', '-final_delay', String(Math.round(last.ms / 10)),
      '-flags', '+bitexact', '-fflags', '+bitexact',
      join(opts.out, GIF),
    ]);
    // The still: the finished run, delivered and probed, for readers who prefer no motion.
    const done = scenes.findLastIndex((s) => s.kind === 'terminal');
    copyFileSync(join(frames, `frame-${String(done).padStart(2, '0')}.png`), join(opts.out, STILL));
    process.stdout.write(`${JSON.stringify({ gif: join(opts.out, GIF), still: join(opts.out, STILL), frames: scenes.length, ms: scenes.reduce((n, s) => n + s.ms, 0) })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
