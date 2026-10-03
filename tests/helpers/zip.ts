/**
 * Minimal ZIP reader for tests: lists and extracts STORE / DEFLATE entries
 * from the central directory, with no dependency and no shell `unzip`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  data: Buffer;
  externalAttributes: number;
  dosTime: number;
  dosDate: number;
}

export function readZip(file: string): ZipEntry[] {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const dosTime = buf.readUInt16LE(p + 12);
    const dosDate = buf.readUInt16LE(p + 14);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttributes = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    entries.push({ name, method, data, externalAttributes, dosTime, dosDate });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractZip(file: string, dest: string): string[] {
  const root = resolve(dest);
  const names: string[] = [];
  for (const entry of readZip(file)) {
    if (entry.name.endsWith('/')) continue;
    const target = resolve(join(root, entry.name));
    if (!target.startsWith(root + sep)) throw new Error(`zip-slip entry: ${entry.name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    names.push(entry.name);
  }
  return names;
}
