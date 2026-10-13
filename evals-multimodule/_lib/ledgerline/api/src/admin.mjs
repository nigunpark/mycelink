/** POST /admin/jobs/redeliver — operational replay after a worker incident. */
export async function redeliverJobs(ctx) {
  return { status: 200, body: { redelivered: await ctx.store.redeliverAll() } };
}
