import { readRegular } from '../../src/security/paths.js';

/**
 * A committed asset's bytes, read and bounded through one descriptor ({@link readRegular}): the size bound and
 * every byte verified come from the file that was opened, never from a path looked at and then opened again. Throws
 * for anything else: absent, a link, a directory, a device, a file over `max` bytes or grown past it while read, or
 * a file the path no longer named once opened.
 */
export function readCommittedAsset(path: string, max: number): Buffer {
  const read = readRegular(path, max);
  if (read === null) throw new Error(`${path} is not a regular file of at most ${max} bytes that it still names`);
  return read.bytes;
}
