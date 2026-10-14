/**
 * The README's animation, docs/assets/quickstart-demo.gif, is the quickstart's scripted walkthrough and says so:
 * scripts/quickstart-demo-gif.mjs plays back SAMPLE-OUTPUT.md (the walkthrough's exact output) and nothing else,
 * every frame carries the SCRIPTED WALKTHROUGH · NO MODEL label, and the committed GIF is the generator's plan —
 * its size, frame count and per-frame delays — so a changed sample or plan without a regenerated GIF fails here.
 * Rendering needs a browser and ffmpeg, so CI checks the plan and the committed files, not a fresh render.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCommittedAsset } from '../helpers/committed-asset.js';
// @ts-expect-error -- plain ESM script without type declarations
import { CHIPS, GIF, HEIGHT, LABEL, STILL, WIDTH, demoScenes, frameHtml, sampleLines } from '../../scripts/quickstart-demo-gif.mjs';

type Scene = { kind: 'title' | 'terminal' | 'end'; ms: number; caption?: string; shown?: number; fresh?: number; status?: Record<string, string> };

const ROOT = resolve(process.cwd());
const ASSETS = join(ROOT, 'docs', 'assets');
const lines = sampleLines() as string[];
const scenes = demoScenes(lines) as Scene[];

/** A GIF's screen size, loop extension and the delay (centiseconds) of each image, read block by block. */
function readGif(buf: Buffer): { width: number; height: number; loops: boolean; delays: number[] } {
  expect(buf.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10] as number;
  let pos = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const skipBlocks = (): void => {
    while ((buf[pos] as number) !== 0) pos += (buf[pos] as number) + 1;
    pos++;
  };
  const delays: number[] = [];
  let pending: number | null = null;
  let loops = false;
  for (;;) {
    const b = buf[pos];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[pos + 1];
      if (label === 0xf9) pending = buf.readUInt16LE(pos + 4);
      if (label === 0xff && buf.subarray(pos + 3, pos + 14).toString('latin1') === 'NETSCAPE2.0') loops = true;
      pos += 2;
      skipBlocks();
    } else if (b === 0x2c) {
      const local = buf[pos + 9] as number;
      pos += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1;
      skipBlocks();
      delays.push(pending ?? 0);
      pending = null;
    } else throw new Error(`unexpected GIF block 0x${String(b?.toString(16))} at ${pos}`);
  }
  return { width, height, loops, delays };
}

describe('docs/assets/quickstart-demo.gif', () => {
  it('plays every line of the scripted walkthrough, in order and verbatim, in 45 to 60 seconds', () => {
    const terminal = scenes.filter((s) => s.kind === 'terminal');
    expect(scenes[0]?.kind).toBe('title');
    expect(scenes.at(-1)?.kind).toBe('end');
    expect(terminal.at(-1)?.shown).toBe(lines.length);
    expect(terminal.reduce((n, s) => n + (s.fresh as number), 0)).toBe(lines.length);
    const total = scenes.reduce((n, s) => n + s.ms, 0);
    expect(total).toBeGreaterThanOrEqual(45_000);
    expect(total).toBeLessThanOrEqual(60_000);
    expect(lines[1]).toMatch(/^Scripted worker and reviewer, no model/);
  });

  it('labels every frame as the scripted walkthrough, with no remote asset', () => {
    for (const scene of scenes) {
      const html = frameHtml(scene, lines) as string;
      expect(html).toContain(LABEL);
      expect(html).not.toMatch(/https?:|url\(|<script|<link|<img/i);
    }
    for (const scene of scenes.filter((s) => s.kind === 'terminal')) {
      const html = frameHtml(scene, lines) as string;
      for (const line of lines.slice(0, scene.shown).filter((l) => l.trim() !== '')) {
        expect(html).toContain(line.replace(/^\[[a-z]+\] */, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').trim());
      }
    }
  });

  it("shows the controller's real statuses: the planted gap, the rework, the candidate and the delivery", () => {
    const seen = (key: string): string[] => scenes.filter((s) => s.kind === 'terminal').map((s) => (s.status as Record<string, string>)[key] as string);
    expect((CHIPS as [string, string][]).map(([key]) => key)).toEqual(['api', 'web', 'review', 'candidate', 'delivery', 'probe']);
    expect(seen('review')).toEqual(expect.arrayContaining(['R001 GAP AC-4', 'R002 PASS']));
    expect(seen('web')).toEqual(expect.arrayContaining(['REOPENED', 'DONE']));
    expect(seen('candidate')).toEqual(expect.arrayContaining(['refused: gap open', 'C001 immutable']));
    expect(seen('delivery').at(-1)).toBe('ACCEPTED');
    expect(seen('probe')[0]).toBe('—');
    expect(seen('probe')).toEqual(expect.arrayContaining(['0/4 on baselines', '4/4 delivered']));
  });

  it('is the committed render of that plan: size, frames, delays, under 5 MB, looping', () => {
    // Bounded and parsed from the one descriptor that was opened, never a path checked and then read again.
    const gif = readGif(readCommittedAsset(join(ASSETS, GIF), 5 * 1024 * 1024));
    expect([gif.width, gif.height]).toEqual([WIDTH, HEIGHT]);
    expect(gif.loops).toBe(true);
    expect(gif.delays).toEqual(scenes.map((s) => Math.round(s.ms / 10)));
  });

  it('has a still for readers who prefer no motion, at the same size', () => {
    const png = readCommittedAsset(join(ASSETS, STILL), 5 * 1024 * 1024);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([WIDTH, HEIGHT]);
  });

  it('is embedded near the README hero with a caption that says it is scripted', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const hero = readme.slice(0, readme.indexOf('## How it works'));
    expect(hero).toContain(`docs/assets/${GIF}`);
    expect(hero).toContain(`docs/assets/${STILL}`);
    expect(hero).toMatch(/prefers-reduced-motion: reduce/);
    expect(hero).toMatch(/[Ss]cripted walkthrough, no model/);
  });
});
