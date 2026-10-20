/** Operator-only first workspace setup; credentials are read from environment and never printed. */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {z} from 'zod';
import {withTenant,pool,systemPool} from './lib/db.js';
import {audit} from './lib/events.js';
async function main(){
  const input=z.object({company:z.string().min(2),slug:z.string().regex(/^[a-z0-9-]{3,40}$/),name:z.string().min(2),email:z.string().email(),password:z.string().min(12).refine(v=>Buffer.byteLength(v)<=72)}).safeParse({company:process.env.BOOTSTRAP_COMPANY,slug:process.env.BOOTSTRAP_SLUG,name:process.env.BOOTSTRAP_OWNER_NAME,email:process.env.BOOTSTRAP_OWNER_EMAIL,password:process.env.BOOTSTRAP_OWNER_PASSWORD});
  if(!input.success)throw new Error('Set valid BOOTSTRAP_COMPANY, BOOTSTRAP_SLUG, BOOTSTRAP_OWNER_NAME, BOOTSTRAP_OWNER_EMAIL and a 12+ character BOOTSTRAP_OWNER_PASSWORD.');
  const b=input.data,hash=await bcrypt.hash(b.password,12),tenant=crypto.randomUUID();
  await withTenant(tenant,async tx=>{
    await tx.query('INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)',[tenant,b.company,b.slug]);
    const owner=(await tx.query(`INSERT INTO users(tenant_id,email,password_hash,full_name,role) VALUES($1,$2,$3,$4,'owner') RETURNING id`,[tenant,b.email.toLowerCase(),hash,b.name])).rows[0];
    await audit(tx,tenant,owner.id,'tenant',tenant,'operator_bootstrap');
  });
  console.log('Workspace and owner created. Credentials were not printed. Remove bootstrap password variables after use.');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Bootstrap failed');process.exitCode=1;}).finally(async()=>{await pool.end();await systemPool.end();});
