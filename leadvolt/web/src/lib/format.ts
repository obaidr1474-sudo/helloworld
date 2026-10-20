const AED = new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 });
export const num = (n: number) => AED.format(n || 0);
export function money(n?: number | null) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `AED ${(v / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 1e3) return `AED ${Math.round(v / 1e3)}K`;
  return `AED ${AED.format(v)}`;
}
export function rel(iso?: string | null) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now(); const a = Math.abs(ms);
  const m = Math.round(a / 6e4), h = Math.round(a / 36e5), d = Math.round(a / 864e5);
  const s = m < 60 ? `${m}m` : h < 48 ? `${h}h` : `${d}d`;
  return ms < 0 ? `${s} ago` : `in ${s}`;
}
export const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export function toLocalInput(d: Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
export const SOURCES: Record<string, string> = { bayut: 'Bayut', property_finder: 'Property Finder', dubizzle: 'Dubizzle', facebook: 'Facebook', google: 'Google Ads', website: 'Website', ivr: 'IVR call', whatsapp: 'WhatsApp', channel_partner: 'Channel partner', referral: 'Referral', walk_in: 'Walk-in', other: 'Other' };
export const STAGE_LABEL: Record<string, string> = { new: 'New', contacted: 'Contacted', meeting: 'Meeting', site_visit: 'Site visit', eoi: 'EOI', booked: 'Booked', lost: 'Closed lost' };

export function dateInZone(iso:string,zone='Asia/Dubai'){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
  const get=(name:string)=>parts.find(p=>p.type===name)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function dateStartInZone(date:string,zone='Asia/Dubai'){
  const [y,m,d]=date.split('-').map(Number),target=Date.UTC(y,m-1,d);
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let instant=target;
  for(let n=0;n<3;n++){
    const parts=formatter.formatToParts(new Date(instant)),v=(k:string)=>Number(parts.find(p=>p.type===k)!.value);
    const offset=Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'),v('second'))-instant;
    const adjusted=target-offset;if(adjusted===instant)break;instant=adjusted;
  }
  return new Date(instant).toISOString();
}
export function nextDate(date:string){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
