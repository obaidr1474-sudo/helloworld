import {describe,expect,it} from 'vitest';
import {makeTotp,totpStep,encryptMfa,decryptMfa,normalizeRecovery} from '../src/services/security.js';
import {parseCsv} from '../../web/src/lib/csv-import.js';
describe('authenticator, credential encryption and portal CSV parsing',()=>{
 it('matches published RFC 6238 six-digit SHA1 vectors and checks adjacent time steps',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const cases:[[number,string],...Array<[number,string]>]=[[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']];
  for(const [seconds,expected] of cases){expect(makeTotp(secret).generate({timestamp:seconds*1000})).toBe(expected);expect(totpStep(secret,expected,seconds*1000)).toBe(Math.floor(seconds/30));}
  expect(totpStep(secret,'badcode')).toBeNull();
 });
 it('authenticates encrypted secrets and rejects tampering',()=>{
  const secret='FICTIONAL-SECRET',encrypted=encryptMfa(secret);expect(encrypted).not.toContain(secret);expect(decryptMfa(encrypted)).toBe(secret);
  const parts=encrypted.split('.');parts[3]=Buffer.from('changed').toString('base64');expect(()=>decryptMfa(parts.join('.'))).toThrow();
  expect(encryptMfa(secret)).not.toBe(encrypted);expect(normalizeRecovery('ABC-123 DEF')).toBe('abc123def');
 });
 it('parses quoted commas, quotes, newlines, BOM and empty rows without changing IDs',()=>{
  const rows=parseCsv('\uFEFFevent_id,name\r\n"000123","A, B"\r\n"event-2","A ""quoted"" name\nwith newline"\r\n\r\n');
  expect(rows).toEqual([['event_id','name'],['000123','A, B'],['event-2','A "quoted" name\nwith newline']]);
  expect(()=>parseCsv('id\n"unfinished')).toThrow();expect(()=>parseCsv('id\n"finished"bad')).toThrow();
 });
});
