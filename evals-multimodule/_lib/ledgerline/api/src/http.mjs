import { DomainError, ERROR_CODES, validationError } from '../vendor/ledger-core/index.mjs';

const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw validationError('request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw validationError('request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('request body must be a JSON object');
  }
  return body;
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res, error) {
  if (error instanceof DomainError) {
    sendJson(res, error.status, { error: error.toJSON() });
    return;
  }
  sendJson(res, 500, { error: { code: ERROR_CODES.INTERNAL, message: 'internal error' } });
}

/** Tiny router: routes are [method, '/path/:param', handler]. */
export function createRouter(routes) {
  const compiled = routes.map(([method, pattern, handler]) => {
    const names = [];
    const source = pattern.replace(/:([a-z_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    return { method, regex: new RegExp(`^${source}$`), names, handler };
  });
  return function match(method, pathname) {
    for (const route of compiled) {
      const m = route.regex.exec(pathname);
      if (!m || route.method !== method) continue;
      const params = {};
      route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params };
    }
    return { handler: null, params: {} };
  };
}

export function notFound() {
  return new DomainError(ERROR_CODES.NOT_FOUND, 'no such route');
}
