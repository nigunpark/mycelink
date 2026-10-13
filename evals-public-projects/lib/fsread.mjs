/**
 * A regular file read through one descriptor, never a path looked at and then
 * opened again (as Mycelink reads one: src/security/paths.ts readRegular).
 *
 * Opened without following a final link and without blocking (a FIFO swapped
 * in cannot hang the harness); the descriptor must be a regular file within
 * `max` bytes, and the path, looked up again without following it, must
 * still name that very file — where the open follows a final link (Windows
 * has no O_NOFOLLOW), a link swapped in is caught by its file id. At most
 * `max` bytes are read however the file grows meanwhile. Paths may be strings
 * or Buffers (a name Linux allows that is no UTF-8).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/** `{ bytes, mode }` of the regular file at `path`, or null: absent, a link, a directory, a device or FIFO, over `max`, swapped. */
export function readRegular(path, max = Number.MAX_SAFE_INTEGER) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(max)) return null;
    const now = lstatSync(path, { bigint: true });
    // Node 22.12 on Windows leaves a path lookup's `dev` at 0; the file id still tells the file apart.
    if (now.isSymbolicLink() || !now.isFile() || now.ino !== opened.ino || (now.dev !== opened.dev && now.dev !== 0n)) return null;
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1 << 20, max - total + 1));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > max) return null;
      chunks.push(chunk.subarray(0, n));
    }
    return { bytes: Buffer.concat(chunks, total), mode: Number(opened.mode) };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
