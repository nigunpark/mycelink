/** Error returned by the API, carrying its { code, message } envelope. */
export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.error = error ?? { code: 'INTERNAL', message: `HTTP ${status}` };
  }
}

export function createClient(baseUrl) {
  if (!baseUrl) throw new Error('no API URL: pass --api or set LEDGER_API_URL');
  const base = baseUrl.replace(/\/+$/, '');
  return async function request(method, path, { body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text === '' ? {} : JSON.parse(text);
    if (!res.ok) throw new ApiError(res.status, json.error);
    return json;
  };
}
