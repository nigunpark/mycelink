/**
 * Hashing primitives for the public-project benchmark.
 *
 * - canonicalJson: one byte-stable JSON form (sorted keys, no undefined, no
 *   non-finite numbers) so records hash the same on every machine.
 * - gitBlobSha / gitTreeSha: git object ids (SHA-1 object format) computed in
 *   memory. The verifier names the trees it replays (start, RED, GREEN)
 *   without writing a single object into the repository it is judging.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of a file, streamed (bundles and caches can be large). */
export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolvePromise(h.digest('hex')));
  });
}

export function canonicalJson(value) {
  const walk = (v, where) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(v)) throw new Error(`canonicalJson: ${where} is not a finite number`);
        return JSON.stringify(v);
      case 'undefined':
        throw new Error(`canonicalJson: ${where} is undefined`);
      case 'object': {
        if (Array.isArray(v)) return `[${v.map((x, i) => walk(x, `${where}[${i}]`)).join(',')}]`;
        const keys = Object.keys(v).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k], `${where}.${k}`)}`).join(',')}}`;
      }
      default:
        throw new Error(`canonicalJson: ${where} is a ${typeof v}`);
    }
  };
  return walk(value, '$');
}

export function canonicalSha256(value) {
  return sha256Hex(canonicalJson(value));
}

function gitObjectSha(type, body) {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

export function gitBlobSha(content) {
  return gitObjectSha('blob', Buffer.isBuffer(content) ? content : Buffer.from(content));
}

const MODES = new Set(['100644', '100755', '120000', '160000']);

/** Hosts whose file systems alias names (case, normalization, 8.3, streams, ignorable code points): judged strictly. */
const ALIASING_HOSTS = new Set(['win32', 'darwin']);
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const HAS_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const WINDOWS_CHARS = /[<>:"|?*]/;
const SHORT_NAME = /^[^~]{1,6}~[0-9]+(\.[^.]*)?$/;

/**
 * What a path segment names on the most permissive of NTFS and HFS+:
 * compatibility forms folded (fullwidth `．ｇｉｔ` is `.git`), ignorable code
 * points (zero-width, BOM, bidi marks, soft hyphen) dropped, an NTFS stream
 * suffix and trailing dots and spaces cut, case folded both ways (so the
 * dotless `ı`, which NTFS upper-cases to `I`, folds to `i`).
 */
function aliasKey(segment) {
  let s = segment.normalize('NFKC').replace(IGNORABLE, '');
  const stream = s.indexOf(':');
  if (stream >= 0) s = s.slice(0, stream);
  return s.replace(/[. ]+$/, '').toUpperCase().toLowerCase();
}

/** `.git` itself, or any name a host resolves to it (git's own NTFS and HFS+ protections, and more). */
function isDotGit(segment) {
  const key = aliasKey(segment);
  return key === '.git' || /^git~[0-9]+$/.test(key);
}

/**
 * A repository-relative path git would store, or an error. Every alias of
 * `.git` is refused on every host; on hosts whose file systems alias names
 * (Windows, macOS) anything they would alias, reserve or silently rewrite
 * is refused too, so a delivered tree can never write somewhere other than
 * the path the verifier judged.
 */
export function assertSafeTreePath(path, { platform = process.platform } = {}) {
  const segments = typeof path === 'string' ? path.split('/') : [];
  const strict = ALIASING_HOSTS.has(platform);
  const unsafe = (s) =>
    s === '' ||
    s === '.' ||
    s === '..' ||
    s.includes('\\') ||
    CONTROL.test(s) ||
    isDotGit(s) ||
    (strict && (/[. ]$/.test(s) || s.includes(':') || SHORT_NAME.test(s) || HAS_IGNORABLE.test(s))) ||
    (platform === 'win32' && (WINDOWS_DEVICE.test(s) || WINDOWS_CHARS.test(s)));
  if (segments.length === 0 || segments.some(unsafe)) throw new Error(`unsafe tree path: ${JSON.stringify(path)}`);
  return segments;
}

/**
 * Fail closed when two paths (or their directories) would be one entry on
 * the host's file system: case-insensitive and normalization-insensitive on
 * Windows and macOS. Elsewhere names are bytes and never collide.
 */
export function assertNoPathCollisions(paths, { platform = process.platform } = {}) {
  if (!ALIASING_HOSTS.has(platform)) return;
  const seen = new Map();
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const original = segments.slice(0, i).join('/');
      const key = original.normalize('NFC').toUpperCase().toLowerCase();
      const other = seen.get(key);
      if (other === undefined) seen.set(key, original);
      else if (other !== original) throw new Error(`tree paths ${JSON.stringify(other)} and ${JSON.stringify(original)} collide on ${platform}`);
    }
  }
}

/**
 * The git tree id of a flat list of `{ path, mode, sha }` entries
 * (`path` uses `/`, `mode` is a git file mode, `sha` a 40-hex object id).
 */
export function gitTreeSha(entries) {
  const root = new Map();
  for (const entry of entries) {
    if (!MODES.has(entry.mode)) throw new Error(`invalid mode ${entry.mode} for ${entry.path}`);
    if (!/^[0-9a-f]{40}$/.test(entry.sha)) throw new Error(`invalid object id for ${entry.path}`);
    const segments = assertSafeTreePath(entry.path);
    let dir = root;
    for (const [i, name] of segments.entries()) {
      const last = i === segments.length - 1;
      const existing = dir.get(name);
      if (last) {
        if (existing !== undefined) {
          throw new Error(existing instanceof Map ? `${entry.path} is both a file and a directory` : `duplicate path ${entry.path}`);
        }
        dir.set(name, { mode: entry.mode, sha: entry.sha });
      } else {
        if (existing === undefined) dir.set(name, new Map());
        else if (!(existing instanceof Map)) throw new Error(`${segments.slice(0, i + 1).join('/')} is both a file and a directory`);
        dir = dir.get(name);
      }
    }
  }
  const hashDir = (dir) => {
    // git orders entries by name, comparing a directory as if it ended in "/".
    const items = [...dir.entries()].map(([name, v]) => ({ name, v, key: v instanceof Map ? `${name}/` : name }));
    items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    const parts = [];
    for (const { name, v } of items) {
      const mode = v instanceof Map ? '40000' : v.mode;
      const sha = v instanceof Map ? hashDir(v) : v.sha;
      parts.push(Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex'));
    }
    return gitObjectSha('tree', Buffer.concat(parts));
  };
  return hashDir(root);
}
