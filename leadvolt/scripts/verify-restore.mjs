// Read-only comparison of a quiescent source and its restored copy. No customer fields are printed.
import pg from 'pg';
import {createHash} from 'node:crypto';
const sourceUrl=process.env.VERIFY_SOURCE_DATABASE_URL;
const restoredUrl=process.env.VERIFY_RESTORE_DATABASE_URL;
if(!sourceUrl||!restoredUrl)throw Error('Set VERIFY_SOURCE_DATABASE_URL and VERIFY_RESTORE_DATABASE_URL. Stop source writes before taking the backup used for comparison.');
const source=new pg.Client({connectionString:sourceUrl}),restored=new pg.Client({connectionString:restoredUrl});
try{
  await source.connect();await restored.connect();
  for(const db of [source,restored])await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const names=async db=>(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  const tables=await names(source);
  if(JSON.stringify(tables)!==JSON.stringify(await names(restored)))throw Error('The table lists differ.');
  let totalRows=0;
  for(const table of tables){
    const name='"'+table.replaceAll('"','""')+'"';
    const digest=async db=>{
      await db.query(`DECLARE restore_check_cursor NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS record FROM ${name} t ORDER BY row_to_json(t)::text`);
      const hash=createHash('sha256');let rows=0;
      try{
        for(;;){const batch=(await db.query('FETCH 500 FROM restore_check_cursor')).rows;if(!batch.length)break;for(const item of batch){hash.update(item.record);hash.update('\n');rows++;}}
      }finally{await db.query('CLOSE restore_check_cursor');}
      return {rows,digest:hash.digest('hex')};
    };
    const a=await digest(source),b=await digest(restored);
    if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Restored data differs in '+table);
    totalRows+=a.rows;
  }
  console.log(JSON.stringify({verifiedTables:tables.length,verifiedRows:totalRows,contentsMatch:true}));
}finally{
  for(const db of [source,restored]){await db.query('ROLLBACK').catch(()=>{});await db.end().catch(()=>{});}
}
