import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './lib/config.js';

/** Minimal forward-only migrator: applies migrations/*.sql in order, once each, as the owner role. */
export async function migrate(url = config.migrationUrl) {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET lock_timeout='30s'");
    await client.query("SELECT pg_advisory_lock(hashtext('leadvolt_schema_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    const done=new Map((await client.query('SELECT name,checksum FROM schema_migrations')).rows.map(r=>[r.name,r.checksum]));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql=await fs.readFile(path.join(dir,f),'utf8');
      const checksum=crypto.createHash('sha256').update(sql).digest('hex');
      if(done.has(f)){
        const expected=done.get(f);
        if(expected&&expected!==checksum)throw new Error(`Previously applied migration ${f} has changed; create a new migration instead.`);
        if(!expected)await client.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1',[f,checksum]);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)`,[f,checksum]);
        await client.query('COMMIT');
        console.log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('leadvolt_schema_migrations'))").catch(()=>{});
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => console.log('migrations complete')).catch((e) => { console.error(e); process.exit(1); });
}
