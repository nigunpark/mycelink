/**
 * JSON Schema registry.
 *
 * Every canonical artifact the controller reads or writes is validated here
 * before it can influence a state transition. Schemas live as plain .json so
 * they are reusable by non-Node tooling and by the control-repo template.
 */
import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schemasDir } from '../util/paths.js';

export type SchemaName =
  | 'repositories'
  | 'portfolio-graph'
  | 'state'
  | 'node-result'
  | 'candidate'
  | 'e2e-scenario'
  | 'loop-contract'
  | 'evidence'
  | 'handoff'
  | 'context-pack'
  | 'session-registry'
  | 'memory-page';

export interface SchemaProblem {
  code: string;
  path: string;
  detail: string;
}

// ajv and ajv-formats are CommonJS; under NodeNext ESM their callable export
// arrives on `.default` in Node but is the namespace itself under some bundlers.
type Ctor = new (opts: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};
const Ajv2020 = ((AjvModule as unknown as { default?: Ctor }).default ??
  (AjvModule as unknown as Ctor)) as Ctor;
type AddFormats = (ajv: unknown) => unknown;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  (addFormatsModule as unknown as AddFormats)) as AddFormats;

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const cache = new Map<SchemaName, ValidateFunction>();

export function getValidator(name: SchemaName): ValidateFunction {
  const cached = cache.get(name);
  if (cached) return cached;
  const file = join(schemasDir(), `${name}.schema.json`);
  const schema = JSON.parse(readFileSync(file, 'utf8')) as object;
  const validate = ajv.compile(schema);
  cache.set(name, validate);
  return validate;
}

function describe(err: ErrorObject): string {
  const where = err.instancePath === '' ? '(root)' : err.instancePath;
  const extra =
    err.params && Object.keys(err.params).length > 0 ? ` ${JSON.stringify(err.params)}` : '';
  return `${where} ${err.message ?? 'is invalid'}${extra}`;
}

/** Validate `value` against a named schema; never throws on invalid data. */
export function validateAgainstSchema(name: SchemaName, value: unknown): SchemaProblem[] {
  const validate = getValidator(name);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((err) => ({
    code: 'SCHEMA',
    path: err.instancePath || '(root)',
    detail: describe(err),
  }));
}
