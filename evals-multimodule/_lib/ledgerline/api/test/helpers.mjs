import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../vendor/ledger-core/index.mjs';
import { createApp } from '../src/app.mjs';

/** Start the app on a free port over a throwaway data directory. */
export async function startApp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-api-'));
  const store = await openStore(dir);
  const server = createApp({ store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { store, base, call, dir };
}
