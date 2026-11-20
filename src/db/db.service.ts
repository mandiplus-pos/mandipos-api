import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

export type Tx = PoolClient;

@Injectable()
export class Db implements OnModuleDestroy {
  private readonly log = new Logger('Db');

  readonly pool = new Pool({
    connectionString: config().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  constructor() {
    // When Neon restarts the compute (maintenance, a settings change) it terminates every
    // connection, and pg reports each idle one as an 'error' event on the pool. Unheard, that
    // event kills the process; heard, pg has already dropped the dead client and the next
    // query simply opens a new connection.
    this.pool.on('error', (err) => this.log.warn(`idle database connection lost: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.pool.query<T>(sql, params)).rows[0] ?? null;
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A connection that dies while checked out emits 'error' on the client itself, not the pool;
    // hear it here (the failing query rejects on its own) and throw that connection away.
    let broken: Error | undefined;
    const onError = (err: Error) => {
      broken = err;
      this.log.warn(`database connection lost mid-transaction: ${err.message}`);
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.removeListener('error', onError);
      client.release(broken);
    }
  }

  /**
   * Runs [fn] in a transaction scoped to one shop. Row-level security reads app.shop_id;
   * set_config(..., true) is transaction-local, so it never leaks through the pooler.
   */
  withShop<T>(shopId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx(async (tx) => {
      await tx.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
      return fn(tx);
    });
  }
}
