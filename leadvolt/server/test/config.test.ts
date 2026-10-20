import {describe,expect,it} from 'vitest';
import {loadConfig} from '../src/lib/config.js';
import {signIntakeV2,verifyIntakeV2} from '../src/services/intake.js';
describe('production configuration and intake authentication',()=>{
  const valid={AUTH_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),NODE_ENV:'production',WORKER_DATABASE_URL:'postgres://leadvolt_worker:fixture@localhost/example',DATABASE_URL:'postgres://app:fixture@localhost/example',JWT_SECRET:'a-strong-fixture-secret-with-more-than-32-characters',CORS_ORIGIN:'https://crm.example.test',PUBLIC_BASE_URL:'https://crm.example.test'};
  it('fails closed without explicit production credentials and allowed origins',()=>{
    expect(()=>loadConfig({NODE_ENV:'production'})).toThrow();
    expect(()=>loadConfig({...valid,JWT_SECRET:'dev-only-change-me-dev-only-change-me'})).toThrow(/JWT_SECRET/);
    expect(()=>loadConfig({...valid,AUTH_ENCRYPTION_KEY:'bad-key'})).toThrow(/AUTH_ENCRYPTION_KEY/);
    expect(()=>loadConfig({...valid,AUTH_ENCRYPTION_KEY:undefined})).toThrow(/AUTH_ENCRYPTION_KEY/);
    expect(()=>loadConfig({...valid,CORS_ORIGIN:'*'})).toThrow(/CORS_ORIGIN/);
    expect(()=>loadConfig({...valid,PUBLIC_BASE_URL:'http://crm.example.test'})).toThrow(/HTTPS/);
    const result=loadConfig(valid);expect(result.allowRegistration).toBe(false);expect(result.allowLegacyIntake).toBe(false);expect(result.trustProxy).toBe(false);
  });
  it('requires complete workspace-bound WhatsApp production configuration',()=>{
    expect(()=>loadConfig({...valid,WA_ACCESS_TOKEN:'fixture-token'})).toThrow(/WA_WORKSPACE/);
    expect(()=>loadConfig({...valid,WA_API_VERSION:'bad'})).toThrow(/WA_API_VERSION/);
  });
  it('binds webhook signatures to body, source and a short validity window',()=>{
    const secret='fixture-key',body='{"phone":"+971500000000"}',timestamp=String(Math.floor(Date.now()/1000));const signature=signIntakeV2(secret,body,'bayut',timestamp);
    expect(verifyIntakeV2(secret,body,'bayut',timestamp,signature)).toBe(true);
    expect(verifyIntakeV2(secret,body,'property_finder',timestamp,signature)).toBe(false);
    expect(verifyIntakeV2(secret,body+' ','bayut',timestamp,signature)).toBe(false);
    expect(verifyIntakeV2(secret,body,'bayut',timestamp,signature,Number(timestamp)*1000+301000)).toBe(false);
  });
});
