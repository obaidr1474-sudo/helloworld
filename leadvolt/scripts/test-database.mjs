import {spawnSync} from 'node:child_process';
const names=['TEST_DATABASE_URL','TEST_MIGRATION_URL'];
for(const name of names){
 const value=process.env[name];if(!value){console.error(`${name} is required. Integration tests must use a disposable database.`);process.exit(1);}
 const database=decodeURIComponent(new URL(value).pathname.slice(1));
 if(!/(^test[_-]|[_-]test($|[_-]))/.test(database)&&process.env.CONFIRM_TEST_DATABASE!==database){console.error(`${name} must identify a disposable test database. Set CONFIRM_TEST_DATABASE to its exact name only when it is safe to recreate the schema.`);process.exit(1);}
}
const result=spawnSync('npm',['test','-w','server'],{stdio:'inherit',env:process.env});process.exit(result.status??1);
