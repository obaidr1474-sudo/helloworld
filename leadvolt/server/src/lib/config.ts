import 'dotenv/config';

export function loadConfig(env:NodeJS.ProcessEnv) {
  const production=env.NODE_ENV==='production';
  const required=(name:string,fallback?:string)=>{const value=env[name]??fallback;if(!value) throw new Error(`${name} is required`);return value;};
  const jwtSecret=required('JWT_SECRET',production?undefined:'dev-only-change-me-dev-only-change-me');
  if (production&&(jwtSecret.length<32||/change-me|dev-only|password|^secret$/i.test(jwtSecret))) throw new Error('JWT_SECRET must be a strong, unique secret of at least 32 characters');
  const corsOrigin=required('CORS_ORIGIN',production?undefined:'http://localhost:5173').split(',').map(v=>v.trim()).filter(Boolean);
  if (corsOrigin.some(v=>{try {const u=new URL(v);return u.origin!==v||!['http:','https:'].includes(u.protocol)||(production&&u.protocol!=='https:');}catch{return true;}})) throw new Error('CORS_ORIGIN must contain exact allowed origins; production requires HTTPS');
  const publicBaseUrl=required('PUBLIC_BASE_URL',production?undefined:'http://localhost:5173').replace(/\/$/,'');
  if (production&&new URL(publicBaseUrl).protocol!=='https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production');
  const positive=(name:string,fallback:number)=>{const v=Number(env[name]??fallback);if(!Number.isInteger(v)||v<1) throw new Error(`${name} must be a positive integer`);return v;};
  if(production&&env.WA_ACCESS_TOKEN&&(!env.WA_WORKSPACE||!env.WA_PHONE_NUMBER_ID||!env.WA_APP_SECRET||!env.WA_VERIFY_TOKEN||!env.WA_API_VERSION))throw new Error('WhatsApp production configuration requires WA_WORKSPACE, WA_PHONE_NUMBER_ID, WA_APP_SECRET, WA_VERIFY_TOKEN and WA_API_VERSION');
  if(env.WA_API_VERSION&&!/^v[1-9]\d\.\d+$/.test(env.WA_API_VERSION))throw new Error('WA_API_VERSION must be a supported Graph API version');
  return {
    production,port:positive('PORT',4000),host:env.HOST??'0.0.0.0',
    databaseUrl:required('DATABASE_URL',production?undefined:'postgres://leadvolt_app:leadvolt_app@localhost:5432/leadvolt'),
    workerDatabaseUrl:required('WORKER_DATABASE_URL',production?undefined:'postgres://leadvolt_worker:leadvolt_worker@localhost:5432/leadvolt'),
    migrationUrl:env.MIGRATION_DATABASE_URL??env.DATABASE_URL??'postgres://leadvolt:leadvolt@localhost:5432/leadvolt',
    jwtSecret,corsOrigin,publicBaseUrl,trustProxy:env.TRUST_PROXY?.split(',').map(v=>v.trim()).filter(Boolean)??false,
    allowRegistration:env.ALLOW_PUBLIC_REGISTRATION=== 'true'||(!production&&env.ALLOW_PUBLIC_REGISTRATION!=='false'),
    allowLegacyIntake:!production||env.ALLOW_LEGACY_INTAKE_SIGNATURES==='true',
    whatsapp:{verifyToken:env.WA_VERIFY_TOKEN??'',appSecret:env.WA_APP_SECRET??'',accessToken:env.WA_ACCESS_TOKEN??'',phoneNumberId:env.WA_PHONE_NUMBER_ID??'',workspace:env.WA_WORKSPACE??'',apiVersion:env.WA_API_VERSION??'v24.0'},
    workers:{enabled:env.WORKERS_ENABLED!=='false',slaIntervalMs:positive('SLA_INTERVAL_MS',30000)},
    poolMax:positive('PG_POOL_MAX',20),sessionHours:positive('SESSION_HOURS',8),
  };
}
export const config=loadConfig(process.env);
