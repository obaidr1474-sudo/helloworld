import {describe,expect,it} from 'vitest';
import {dateInZone,dateStartInZone,nextDate} from '../../web/src/lib/format';
describe('workspace date filters',()=>{
 it('uses the Dubai business day independently of the browser timezone',()=>{expect(dateInZone('2026-10-20T21:00:00Z','Asia/Dubai')).toBe('2026-10-21');expect(dateStartInZone('2026-10-21','Asia/Dubai')).toBe('2026-10-20T20:00:00.000Z');});
 it('preserves daylight-saving boundaries instead of assuming every local day has 24 hours',()=>{expect(dateStartInZone('2026-03-08','America/New_York')).toBe('2026-03-08T05:00:00.000Z');expect(dateStartInZone(nextDate('2026-03-08'),'America/New_York')).toBe('2026-03-09T04:00:00.000Z');});
});
