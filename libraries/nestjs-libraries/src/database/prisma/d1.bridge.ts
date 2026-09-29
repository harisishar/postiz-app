// Minimal D1Database lookalike for @prisma/adapter-d1 when running inside a
// Cloudflare Container: the container has no D1 binding, so every call is sent
// over HTTP to the Worker's outbound handler (deploy/cloudflare/src/index.ts),
// which runs it against the real binding. Only implements what PrismaD1 calls.
const call = async (url: string, body: Record<string, unknown>) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    // keep the D1 message so PrismaD1 can map it to a SQLite error code
    throw new Error(data.error);
  }
  return data;
};

export const d1Bridge = (url: string) => ({
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      raw: () => call(url, { op: 'raw', sql, args }),
      run: () => call(url, { op: 'run', sql, args }),
    }),
  }),
  exec: (sql: string) => call(url, { op: 'exec', sql }),
});
