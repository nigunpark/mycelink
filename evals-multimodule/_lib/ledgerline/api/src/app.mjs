import { createServer } from 'node:http';
import { createRouter, notFound, readJsonBody, sendError, sendJson } from './http.mjs';
import { captureOrder, getOrder, listOrderEvents, postOrder } from './orders.mjs';
import { redeliverJobs } from './admin.mjs';

export const routes = [
  ['GET', '/healthz', async () => ({ status: 200, body: { ok: true } })],
  ['POST', '/orders', postOrder],
  ['GET', '/orders/:order_id', getOrder],
  ['POST', '/orders/:order_id/capture', captureOrder],
  ['GET', '/orders/:order_id/events', listOrderEvents],
  ['POST', '/admin/jobs/redeliver', redeliverJobs],
];

export function createApp({ store }) {
  const match = createRouter(routes);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const { handler, params } = match(req.method ?? 'GET', url.pathname);
      if (!handler) throw notFound();
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const result = await handler({ store, params, body, headers: req.headers, query: url.searchParams });
      const headers = result.replayed ? { 'idempotent-replayed': 'true' } : {};
      sendJson(res, result.status, result.body, headers);
    } catch (error) {
      if (error?.name !== 'DomainError') console.error(error);
      sendError(res, error);
    }
  });
}
