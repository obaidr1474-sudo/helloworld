import pg from 'pg';
import { config } from './config.js';

// numeric -> number (values fit in double for AED amounts), bigint -> number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max:config.poolMax,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:10000,query_timeout:12000,idle_in_transaction_session_timeout:15000 });

export const systemPool=new pg.Pool({connectionString:config.workerDatabaseUrl,max:5,connectionTimeoutMillis:5000,statement_timeout:10000,allowExitOnIdle:true});
export type Tx = pg.PoolClient;

/** Run fn in a transaction scoped to one tenant (RLS via app.tenant_id). */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Cross-tenant transaction for background workers only. */
export async function withSystem<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>{
  const client=await systemPool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Queries that are not tenant-scoped (tenants table lookups). */
export const q = <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => pool.query<R>(text, params);

export async function assertRuntimeDatabase(production=config.production,connectionPool=pool) {
  const result=await connectionPool.query(`SELECT r.rolsuper,r.rolbypassrls,
    EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('users','leads') AND pg_has_role(current_user,tableowner,'MEMBER')) AS owns_data,
    EXISTS(SELECT 1 FROM pg_roles w WHERE w.rolname='leadvolt_worker' AND pg_has_role(current_user,w.oid,'MEMBER')) AS worker_access
    FROM pg_roles r WHERE rolname=current_user`);
  if (production && (result.rows[0].rolsuper||result.rows[0].rolbypassrls||result.rows[0].owns_data||result.rows[0].worker_access)) throw new Error('Runtime DATABASE_URL must use a non-owner role without RLS bypass or worker membership');
}

export async function assertWorkerDatabase(){
  if(!config.production)return;
  const r=(await systemPool.query(`SELECT current_user AS principal,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(r.principal!=='leadvolt_worker'||r.rolsuper||r.rolbypassrls)throw new Error('WORKER_DATABASE_URL must use the dedicated non-superuser leadvolt_worker role');
}
