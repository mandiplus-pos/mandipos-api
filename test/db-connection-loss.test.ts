import { Client } from 'pg';

// A Neon compute restart (weekly maintenance, a settings change) terminates every connection.
// Before Db listened for it, the pool's 'error' event for an idle connection killed the whole
// process. This reproduces the restart with pg_terminate_backend on the test's own connections.
// Run with DB_LOSS_URL=<a direct (unpooled) Postgres URL you may open and close sessions on>.
const url = process.env.DB_LOSS_URL;

(url ? describe : describe.skip)('Db survives losing its connections', () => {
  let Db: typeof import('../src/db/db.service').Db;
  let admin: Client;

  beforeAll(async () => {
    process.env.APP_ENV = 'test';
    process.env.DATABASE_URL = url;
    process.env.JWT_SECRET ??= 'x'.repeat(32);
    process.env.OTP_HASH_SECRET ??= 'y'.repeat(16);
    ({ Db } = await import('../src/db/db.service'));
    admin = new Client({ connectionString: url });
    await admin.connect();
  });
  afterAll(() => admin.end());

  const kill = (pid: number) => admin.query('SELECT pg_terminate_backend($1)', [pid]);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('drops an idle connection the server closed and carries on', async () => {
    const db = new Db(); // no listener of the test's own: the pool must cope by itself
    const [{ pid }] = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(db.pool.idleCount).toBe(1);
    await kill(pid);
    await until(() => db.pool.totalCount === 0);
    expect(db.pool.totalCount).toBe(0); // the dead connection left the pool
    const [{ ok }] = await db.query<{ ok: number }>('SELECT 1 AS ok');
    expect(ok).toBe(1);
    await db.onModuleDestroy();
  });

  it('fails only the transaction whose connection died, then works again', async () => {
    const db = new Db();
    await expect(
      db.tx(async (tx) => {
        const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await kill(rows[0].pid);
        await tx.query('SELECT 1');
      }),
    ).rejects.toThrow();
    expect(db.pool.totalCount).toBe(0); // the dead connection was thrown away, not reused
    const n = await db.tx(async (tx) => (await tx.query<{ n: number }>('SELECT 2 AS n')).rows[0].n);
    expect(n).toBe(2);
    await db.onModuleDestroy();
  });
});
