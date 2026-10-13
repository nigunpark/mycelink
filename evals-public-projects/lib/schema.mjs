/**
 * Strict JSON Schema (draft 2020-12 subset) validation for benchmark
 * manifests, with no dependencies.
 *
 * Only the keywords the committed schemas use are implemented. Any other
 * keyword makes validation throw: a constraint that is silently ignored would
 * let a broken manifest through, so the validator fails closed instead.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'examples', '$comment', 'default']);
const ASSERTIONS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  '$ref',
  '$defs',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  return expected === actual || (expected === 'number' && actual === 'integer');
}

const isPlainObject = (v) => typeOf(v) === 'object';

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function childPath(path, key) {
  return typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Validate `value` against `schema`. Returns the list of problems as
 * "<json path>: <reason>" strings (empty when valid). Throws on a schema the
 * validator cannot fully enforce.
 */
export function validate(schema, value) {
  const root = schema;
  const problems = [];
  const resolveRef = (ref) => {
    const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
    if (!m) throw new Error(`unsupported $ref ${ref}: only local #/$defs/<name> references are allowed`);
    const target = root.$defs?.[m[1]];
    if (target === undefined) throw new Error(`unresolved $ref ${ref}`);
    return target;
  };
  const walk = (s, v, path) => {
    if (s === true) return;
    if (s === false) {
      problems.push(`${path}: no value is allowed here`);
      return;
    }
    if (!isPlainObject(s)) throw new Error(`invalid schema at ${path}`);
    for (const key of Object.keys(s)) {
      if (!ANNOTATIONS.has(key) && !ASSERTIONS.has(key)) throw new Error(`unsupported schema keyword ${key} at ${path}`);
    }
    if (s.$ref !== undefined) walk(resolveRef(s.$ref), v, path);
    if (s.const !== undefined && !deepEqual(s.const, v)) {
      problems.push(`${path}: must equal ${JSON.stringify(s.const)}`);
      return;
    }
    if (s.enum !== undefined && !s.enum.some((e) => deepEqual(e, v))) {
      problems.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
      return;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(t, v))) {
        problems.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(v)}`);
        return;
      }
    }
    if (typeof v === 'string') {
      const length = [...v].length;
      if (s.minLength !== undefined && length < s.minLength) problems.push(`${path}: shorter than ${s.minLength} characters`);
      if (s.maxLength !== undefined && length > s.maxLength) problems.push(`${path}: longer than ${s.maxLength} characters`);
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) problems.push(`${path}: does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) problems.push(`${path}: less than ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) problems.push(`${path}: greater than ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) problems.push(`${path}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) problems.push(`${path}: more than ${s.maxItems} items`);
      if (s.uniqueItems === true && v.some((x, i) => v.findIndex((y) => deepEqual(x, y)) !== i)) problems.push(`${path}: items are not unique`);
      if (s.items !== undefined) v.forEach((x, i) => walk(s.items, x, childPath(path, i)));
    }
    if (isPlainObject(v)) {
      for (const key of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(v, key)) problems.push(`${path}: missing required property ${key}`);
      }
      const props = s.properties ?? {};
      for (const [key, child] of Object.entries(v)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) walk(props[key], child, childPath(path, key));
        else if (s.additionalProperties === false) problems.push(`${path}: unexpected property ${key}`);
        else if (s.additionalProperties !== undefined && s.additionalProperties !== true) walk(s.additionalProperties, child, childPath(path, key));
      }
    }
  };
  walk(schema, value, '$');
  return problems;
}

/** A committed schema by name (`source-lock`, `prd-case`, ...). */
export function loadSchema(name, dir = SCHEMA_DIR) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid schema name ${name}`);
  return JSON.parse(readFileSync(join(dir, `${name}.schema.json`), 'utf8'));
}

/** Parse a JSON file and validate it; problems are prefixed with the file name. */
export function validateFile(name, file, dir = SCHEMA_DIR) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { doc: null, problems: [`${file}: ${error.message}`] };
  }
  return { doc, problems: validate(loadSchema(name, dir), doc).map((p) => `${file}: ${p}`) };
}
