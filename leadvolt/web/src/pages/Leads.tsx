import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, qs } from '../lib/api';
import { Icon } from '../components/Icon';
import { makeCsv } from '../lib/csv';
import { onEvent, subscribeLead, useRealtimeStatus } from '../lib/realtime';
import { dt, money, num, rel, SOURCES, STAGE_LABEL, toLocalInput } from '../lib/format';
import { errMsg, toast, type Me, type User } from '../App';

export interface Lead {
  id: string; serialNo: number; name: string; phone: string | null; email: string | null; ownerId: string | null; stage: string;
  subStatus: string | null; lostReason: string | null; source: string; subSource: string | null; requirements: any; score: number;
  temperature: 'hot' | 'warm' | 'cold'; reenquiryCount: number; dealValue: number | null; firstResponseAt: string | null;
  nextActionAt: string | null; slaBreached: boolean; createdAt: string; updatedAt: string; version: number; propertyId: string | null;
}
interface Dispo { key: string; label: string; stage: string; subStatuses: string[]; requiresNextAction?: boolean; allowsNextAction?: boolean; requiresDealValue?: boolean; isLost?: boolean }

const SCOPES = [['all', 'All'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['reenquired', 'Re-enquired'], ['sla', 'SLA breach']] as const;
const QUEUES = [['active', 'Active'], ['new', 'New'], ['scheduled', 'Scheduled'], ['overdue', 'Overdue'], ['eoi', 'EOI'], ['booked', 'Booked'], ['lost', 'Closed']] as const;
const active = (l: Lead) => l.stage !== 'lost' && l.stage !== 'booked';
const overdue = (l: Lead) => active(l) && !!l.nextActionAt && new Date(l.nextActionAt) < new Date();

export interface LeadRequest {
  key: number; create?: boolean;
  filters?: { queue?: string; scope?: string; source?: string; ownerId?: string; q?: string; stage?: string; createdFrom?: string; createdTo?: string };
}
const COLUMNS = [['source', 'Source'], ['stage', 'Status'], ['owner', 'Assigned to'], ['budget', 'Budget'], ['next', 'Next follow-up'], ['created', 'Created'], ['temperature', 'Temperature']] as const;

export function Leads({ me, users, initialLeadId, request, onSelect, onRequestHandled }: { me: Me; users: User[]; initialLeadId: string | null; request?: LeadRequest | null; onSelect?: (id: string | null) => void; onRequestHandled?: () => void }) {
  const connected = useRealtimeStatus();
  const [scope, setScope] = useState('all'); const [queue, setQueue] = useState('active');
  const [q, setQ] = useState(''); const [source, setSource] = useState(''); const [owner, setOwner] = useState(''); const [temp, setTemp] = useState('');
  const [stage, setStage] = useState(''); const [createdFrom, setCreatedFrom] = useState(''); const [createdTo, setCreatedTo] = useState('');
  const [sort, setSort] = useState('updated'); const [pageSize, setPageSize] = useState(10);
  const [filtersOpen, setFiltersOpen] = useState(false); const [columnPicker, setColumnPicker] = useState(false);
  const [columns, setColumns] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem('lv_columns') || 'null'); return Array.isArray(saved) ? saved.filter((key: string) => COLUMNS.some(([id]) => key === id)) : COLUMNS.map(([id]) => id); }
    catch { return COLUMNS.map(([id]) => id); }
  });
  const [items, setItems] = useState<Lead[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({}); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState('');
  const [selId, setSelId] = useState<string | null>(initialLeadId);
  const [modal, setModal] = useState<null | 'dispo' | 'new' | 'call' | 'assign' | 'help'>(null);
  const [dispos, setDispos] = useState<Dispo[]>([]); const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<string[]>([]); const [bulkOwner, setBulkOwner] = useState(''); const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const drawerRef = useRef<HTMLElement>(null); const previousFocus = useRef<HTMLElement | null>(null);
  const userName = useCallback((id: string | null) => users.find((u) => u.id === id)?.full_name ?? (id ? 'Former user' : 'Unassigned'), [users]);
  const canAssign = ['owner', 'admin', 'manager'].includes(me.role);
  const params = useMemo(() => ({ scope, queue, q, source, ownerId: owner, temperature: temp, stage, createdFrom, createdTo, sort }), [scope, queue, q, source, owner, temp, stage, createdFrom, createdTo, sort]);
  const queryKey = JSON.stringify({ ...params, pageSize });
  const [pagination, setPagination] = useState<{ key: string; cursors: (string | undefined)[] }>({ key: '', cursors: [undefined] });
  const cursors = pagination.key === queryKey ? pagination.cursors : [undefined];
  const page = cursors.length - 1; const currentCursor = cursors[page];
  useEffect(() => { localStorage.setItem('lv_columns', JSON.stringify(columns)); }, [columns]);
  useEffect(() => { setSelId(initialLeadId); }, [initialLeadId]);
  useEffect(() => {
    if (!request) return;
    const f = request.filters ?? {};
    setScope(f.scope || 'all'); setQueue(f.queue || 'active'); setQ(f.q || ''); setSource(f.source || ''); setOwner(f.ownerId || ''); setStage(f.stage || ''); setTemp(''); setCreatedFrom(f.createdFrom || ''); setCreatedTo(f.createdTo || '');
    setSelId(null); if (request.create) setModal('new'); onRequestHandled?.();
  }, [request]);
  useEffect(() => { onSelect?.(selId); }, [selId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(''); setSelected([]);
    const timer = window.setTimeout(async () => {
      try {
        const [r, c] = await Promise.all([
          api<{ items: Lead[]; nextCursor: string | null }>('GET', '/leads' + qs({ ...params, cursor: currentCursor, limit: pageSize })),
          api<Record<string, number>>('GET', '/leads/counts' + qs(params)),
        ]);
        if (!cancelled) { setItems(r.items); setNextCursor(r.nextCursor); setCounts(c); }
      } catch (e) { if (!cancelled) setLoadError(errMsg(e)); }
      finally { if (!cancelled) setLoading(false); }
    }, q ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [queryKey, currentCursor, reloadKey]);
  useEffect(() => { api<{ dispositions: Dispo[] }>('GET', '/meta/pipeline').then((r) => setDispos(r.dispositions)).catch(e => toast(errMsg(e))); }, []);
  useEffect(() => {
    let t: number | undefined;
    const off = onEvent((e) => { if (e.type.startsWith('lead.') || e.type === 'sla.breached') { clearTimeout(t); t = window.setTimeout(() => setReloadKey((k) => k + 1), 400); } });
    return () => { off(); clearTimeout(t); };
  }, []);
  const sel = items.find((l) => l.id === selId) ?? null;
  const [selLead, setSelLead] = useState<Lead | null>(null);
  useEffect(() => {
    setSelLead(null); if (!selId) return;
    let cancelled = false;
    api<Lead>('GET', `/leads/${selId}`).then(l => { if (!cancelled) setSelLead(l); }).catch((e) => { if (!cancelled) { toast(errMsg(e)); setSelId(null); } });
    const off = subscribeLead(selId);
    return () => { cancelled = true; off(); };
  }, [selId, reloadKey]);
  const lead = selLead?.id === selId ? selLead : sel;
  const move = useCallback((delta: number) => {
    const i = items.findIndex((l) => l.id === selId);
    const n = items[Math.max(0, Math.min(items.length - 1, (i < 0 ? (delta > 0 ? -1 : items.length) : i) + delta))];
    if (n) setSelId(n.id);
  }, [items, selId]);
  useEffect(() => {
    if (!selId) return;
    previousFocus.current = document.activeElement as HTMLElement;
    drawerRef.current?.focus();
    return () => { previousFocus.current?.focus(); };
  }, [!!selId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modal) return;
      if (selId && e.key === 'Tab') {
        const nodes = drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]');
        const first = nodes?.[0], last = nodes?.[nodes.length - 1];
        if (first && last && (!drawerRef.current?.contains(document.activeElement) || document.activeElement === drawerRef.current || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last))) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      }
      if (e.key === 'Escape') { setSelId(null); return; }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j') { e.preventDefault(); move(1); }
      else if (k === 'k') { e.preventDefault(); move(-1); }
      else if (k === '/') { e.preventDefault(); (document.getElementById('lead-search') as HTMLInputElement)?.focus(); }
      else if (e.key === '?') setModal('help');
      else if (!lead) return;
      else if (k === 'd') { e.preventDefault(); setModal('dispo'); }
      else if (k === 'c') { e.preventDefault(); setModal('call'); }
      else if (k === 'a') { e.preventDefault(); setModal('assign'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [move, lead, modal, selId]);
  const afterSave = (next: boolean) => { setModal(null); setReloadKey(k => k + 1); if (next) move(1); };
  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const clearFilters = () => { setSource(''); setOwner(''); setTemp(''); setStage(''); setCreatedFrom(''); setCreatedTo(''); setQ(''); };
  const filterCount = [source, owner, temp, stage, createdFrom, createdTo].filter(Boolean).length;
  const assignSelected = async () => {
    if (!bulkOwner || !selected.length) return;
    setBusy(true);
    try { await api('POST', '/leads/bulk-assign', { leadIds: selected, userId: bulkOwner === 'none' ? null : bulkOwner }); toast(`${selected.length} leads assigned`); setSelected([]); setPagination({ key: queryKey, cursors: [undefined] }); setReloadKey(k => k+1); }
    catch(e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      let rows = selected.length ? items.filter(l => selected.includes(l.id)) : [];
      if (!selected.length) {
        let cursor: string | undefined;
        do { const r = await api<{items:Lead[];nextCursor:string|null}>('GET','/leads'+qs({...params,cursor,limit:200})); rows.push(...r.items); cursor=r.nextCursor??undefined; } while(cursor);
      }
      const csv = makeCsv(['Lead ID','Name','Phone','Email','Source','Status','Assigned to','Temperature','Budget (AED)','Next follow-up','Created'], rows.map(l=>[l.serialNo,l.name,l.phone,l.email,SOURCES[l.source]??l.source,STAGE_LABEL[l.stage],userName(l.ownerId),l.temperature,l.requirements?.budgetMax,l.nextActionAt,l.createdAt]));
      const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})); const a=document.createElement('a'); a.href=url; a.download='leadvolt-leads.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast(`Exported ${rows.length} leads`);
    } catch(e) { toast(errMsg(e)); } finally { setExporting(false); }
  };
  const count = counts[queue] ?? counts.all ?? 0;
  return <div className="pad leads-page">
    <div className="page-heading"><div><div className="eyebrow">RELATIONSHIPS START HERE</div><h1>Leads <span className="title-count">{loading ? '…' : counts.all ?? 0}</span></h1><p>Every opportunity, with the next step in view.</p></div><button className="btn primary" onClick={()=>setModal('new')}><Icon name="plus" size={17}/>Add lead</button></div>
    <section className="card leads-card">
      <div className="scope-tabs" role="group" aria-label="Lead scope">{SCOPES.map(([key,label])=><button key={key} aria-pressed={scope===key} onClick={()=>setScope(key)}>{label}</button>)}</div>
      <div className="queue-tabs" role="group" aria-label="Lead queue">{[['all','All statuses'],...QUEUES].map(([key,label])=><button key={key} aria-pressed={queue===key} onClick={()=>setQueue(key)}>{label}<span>{loading?'—':counts[key]??0}</span></button>)}</div>
      <div className="lead-toolbar"><div className="search"><Icon name="search" size={17}/><input id="lead-search" className="in" placeholder="Search name, phone, email or lead ID" value={q} onChange={e=>setQ(e.target.value)} aria-label="Search leads"/></div><button className={`btn ${filtersOpen?'selected':''}`} aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(!filtersOpen)}><Icon name="filter" size={16}/>Filters{filterCount>0&&<span className="filter-count">{filterCount}</span>}</button><div className="column-control"><button className="btn" aria-expanded={columnPicker} onClick={()=>setColumnPicker(!columnPicker)}><Icon name="columns" size={16}/>Columns</button>{columnPicker&&<div className="column-popover">{COLUMNS.map(([key,label])=><label key={key}><input type="checkbox" checked={columns.includes(key)} onChange={()=>setColumns(c=>c.includes(key)?c.filter(x=>x!==key):[...c,key])}/>{label}</label>)}</div>}</div><button className="btn" disabled={exporting} onClick={exportCsv}><Icon name="download" size={16}/>{exporting?'Exporting…':'Export CSV'}</button><button className="icon-btn bordered" aria-label="Refresh leads" onClick={()=>setReloadKey(k=>k+1)}><Icon name="refresh" size={17}/></button></div>
      {filtersOpen&&<div className="lead-filters">
        <label>Source<select aria-label="Source" className="in" value={source} onChange={e=>setSource(e.target.value)}><option value="">All sources</option>{Object.entries(SOURCES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Assigned to<select aria-label="Assigned to" className="in" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">All agents</option><option value="none">Unassigned</option>{users.map(u=><option key={u.id} value={u.id}>{u.full_name}</option>)}</select></label>
        <label>Temperature<select aria-label="Temperature" className="in" value={temp} onChange={e=>setTemp(e.target.value)}><option value="">All temperatures</option>{['hot','warm','cold'].map(k=><option key={k} value={k}>{k[0].toUpperCase()+k.slice(1)}</option>)}</select></label>
        <label>Stage<select aria-label="Stage" className="in" value={stage} onChange={e=>setStage(e.target.value)}><option value="">All stages</option>{Object.entries(STAGE_LABEL).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Created from<input aria-label="Created from" className="in" type="date" value={createdFrom ? toLocalInput(new Date(createdFrom)).slice(0,10) : ''} onChange={e=>setCreatedFrom(e.target.value?new Date(e.target.value+'T00:00:00').toISOString():'')}/></label>
        <label>Created through<input aria-label="Created through" className="in" type="date" value={createdTo?toLocalInput(new Date(new Date(createdTo).getTime()-864e5)).slice(0,10):''} onChange={e=>setCreatedTo(e.target.value?new Date(new Date(e.target.value+'T00:00:00').getTime()+864e5).toISOString():'')}/></label>
      </div>}
      <div className="results-toolbar"><span>{loading?'Loading leads…':`${count} ${count===1?'lead':'leads'} in this view`}{filterCount>0&&<button className="text-button" onClick={clearFilters}>Clear filters</button>}</span><label>Sort by <select value={sort} onChange={e=>setSort(e.target.value)} aria-label="Sort leads"><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="next_action">Next follow-up</option><option value="score">Lead score</option></select></label></div>
      {selected.length>0&&<div className="bulk-toolbar"><b>{selected.length} selected</b>{canAssign&&<><select className="in" aria-label="Bulk assign to" value={bulkOwner} onChange={e=>setBulkOwner(e.target.value)}><option value="">Assign to…</option><option value="none">Unassigned pool</option>{users.filter(u=>u.is_active).map(u=><option key={u.id} value={u.id}>{u.full_name}</option>)}</select><button className="btn primary sm" disabled={busy||!bulkOwner} onClick={assignSelected}>{busy?'Assigning…':'Assign leads'}</button></>}<button className="text-button" onClick={()=>setSelected([])}>Clear selection</button></div>}
      <div className="tbl-wrap leads-table-wrap" aria-busy={loading}>
        {loadError?<div className="empty"><h3>We couldn’t load these leads</h3><p role="alert">{loadError}</p><button className="btn" onClick={()=>setReloadKey(k=>k+1)}>Try again</button></div>:<table className="tbl leads-table"><thead><tr><th><input type="checkbox" aria-label="Select all leads on this page" checked={!!items.length&&selected.length===items.length} disabled={loading} onChange={()=>setSelected(selected.length===items.length?[]:items.map(l=>l.id))}/></th><th>Lead / contact</th>{COLUMNS.filter(([key])=>columns.includes(key)).map(([key,label])=><th key={key}>{label}</th>)}<th>Quick actions</th></tr></thead><tbody>{!loading&&items.map(l=><tr key={l.id} className={selId===l.id?'selected-row':''}><td><input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.includes(l.id)} onChange={()=>toggle(l.id)}/></td><td><button className="lead-contact" onClick={()=>setSelId(l.id)}><span className={`avatar avatar-${l.serialNo%4}`}>{l.name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><span><b>{l.name}</b><small>{l.phone??l.email??'No contact details'}</small><span className="lead-id">LV-{String(l.serialNo).padStart(4,'0')}{l.reenquiryCount>0&&<span className="pill acc">Re-enquiry ×{l.reenquiryCount}</span>}</span></span></button></td>
        {COLUMNS.filter(([key])=>columns.includes(key)).map(([key])=><td key={key}>{key==='source'?<span className="source-cell"><i className={`source-logo source-${l.source}`}>{(SOURCES[l.source]??l.source)[0]}</i><span>{SOURCES[l.source]??l.source}{l.subSource&&<small>{l.subSource}</small>}</span></span>:key==='stage'?<><span className={`stage-badge stage-${l.stage}`}><i/>{STAGE_LABEL[l.stage]}</span>{l.subStatus&&<small className="cell-secondary">{l.subStatus}</small>}{l.slaBreached&&!l.firstResponseAt&&<span className="pill bad">Response overdue</span>}</>:key==='owner'?<span className="owner-cell"><span className="owner-dot"/>{userName(l.ownerId)}</span>:key==='budget'?<span className="budget-cell">{l.requirements?.budgetMax?money(l.requirements.budgetMax):'—'}</span>:key==='next'?l.nextActionAt?<span className={overdue(l)?'due-over':''}><small className="followup-date">{new Date(l.nextActionAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</small>{overdue(l)?'Overdue · ':''}{rel(l.nextActionAt)}</span>:<span className="muted">Not scheduled</span>:key==='created'?<span className="cell-date">{new Date(l.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span>:<span className={`pill ${l.temperature}`}>● {l.temperature}</span>}</td>)}
        <td><div className="row-actions"><button className="icon-btn" title={`Log call for ${l.name}`} aria-label={`Log call for ${l.name}`} onClick={()=>{setSelId(l.id);setModal('call');}}><Icon name="phone" size={16}/></button>{l.phone&&<a className="icon-btn wa-action" title={`WhatsApp ${l.name}`} aria-label={`WhatsApp ${l.name}`} href={`https://wa.me/${l.phone.replace(/\D/g,'')}`} target="_blank" rel="noopener noreferrer"><Icon name="inbox" size={16}/></a>}<button className="icon-btn" title={`Update status for ${l.name}`} aria-label={`Update status for ${l.name}`} onClick={()=>{setSelId(l.id);setModal('dispo');}}><Icon name="target" size={17}/></button><button className="icon-btn" title={`Open ${l.name}`} aria-label={`Open ${l.name}`} onClick={()=>setSelId(l.id)}><Icon name="chevron" size={16}/></button></div></td></tr>)}</tbody></table>}
        {loading&&<div className="empty" role="status">Loading your leads…</div>}{!loading&&!loadError&&!items.length&&<div className="empty lead-empty"><Icon name="leads" size={35}/><h3>No leads in this view</h3><p>Try another queue or clear the filters to see more opportunities.</p><button className="btn" onClick={clearFilters}>Clear filters</button></div>}
      </div>
      <div className="pagination"><span>{count?`${page*pageSize+1}–${Math.min(page*pageSize+items.length,count)} of ${count} leads`:'0 leads'}</span><div className="grow"/><label>Rows per page <select aria-label="Rows per page" value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}>{[10,25,50].map(n=><option key={n}>{n}</option>)}</select></label><button className="icon-btn bordered" aria-label="Previous page" disabled={loading||page===0} onClick={()=>setPagination({key:queryKey,cursors:cursors.slice(0,-1)})}><Icon name="chevron" size={16} style={{transform:'rotate(180deg)'}}/></button><span className="page-number">{page+1}</span><button className="icon-btn bordered" aria-label="Next page" disabled={loading||!nextCursor} onClick={()=>setPagination({key:queryKey,cursors:[...cursors,nextCursor!]})}><Icon name="chevron" size={16}/></button></div>
    </section>
    <div className="leads-footnote"><span><i className={`live-dot ${connected ? '' : 'reconnecting'}`}/>{connected ? 'Live updates connected' : 'Reconnecting live updates…'}</span><button className="text-button" onClick={()=>setModal('help')}>Keyboard shortcuts <kbd>?</kbd></button></div>
    {selId&&<div className="lead-drawer-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setSelId(null);}}><aside className="lead-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={lead?`Lead details: ${lead.name}`:'Loading lead'} tabIndex={-1}><div className="drawer-toolbar"><span>LEAD DETAILS</span><div className="grow"/><button className="icon-btn" aria-label="Previous lead" onClick={()=>move(-1)} disabled={!items.length||items[0]?.id===selId}><Icon name="chevron" size={17} style={{transform:'rotate(180deg)'}}/></button><button className="icon-btn" aria-label="Next lead" onClick={()=>move(1)} disabled={!items.length||items[items.length-1]?.id===selId}><Icon name="chevron" size={17}/></button><button className="icon-btn" aria-label="Close lead details" onClick={()=>setSelId(null)}><Icon name="close" size={18}/></button></div>{lead?<Workspace key={lead.id} lead={lead} me={me} userName={userName} onBack={()=>setSelId(null)} onAction={setModal} refresh={()=>setReloadKey(k=>k+1)}/>:<div className="empty" role="status">Loading lead…</div>}</aside></div>}
    {modal==='dispo'&&lead&&<DispositionModal key={lead.id} lead={lead} dispos={dispos} users={users} me={me} onClose={()=>setModal(null)} onSaved={afterSave}/>}
    {modal==='call'&&lead&&<CallModal key={lead.id} lead={lead} onClose={()=>setModal(null)} onSaved={(then)=>{setReloadKey(k=>k+1);setModal(then?'dispo':null);}}/>}
    {modal==='assign'&&lead&&<AssignModal key={lead.id} lead={lead} users={users} me={me} onClose={()=>setModal(null)} onSaved={()=>afterSave(false)}/>}
    {modal==='new'&&<NewLeadModal users={users} onClose={()=>setModal(null)} onSaved={id=>{setModal(null);setSelId(id);setReloadKey(k=>k+1);}}/>}
    {modal==='help'&&<Modal title="Keyboard shortcuts" onClose={()=>setModal(null)}><div className="keys">{[['J / K','Next / previous lead'],['D','Update status'],['1–7','Pick status in dialog'],['Shift+Enter','Save & next'],['C','Log call'],['A','Assign'],['/','Search leads'],['Esc','Close']].map(([a,b])=><div key={a}><span>{b}</span><kbd>{a}</kbd></div>)}</div></Modal>}
  </div>;
}

function Workspace({ lead, me, userName, onBack, onAction, refresh }: { lead: Lead; me: Me; userName: (id: string | null) => string; onBack: () => void; onAction: (m: any) => void; refresh: () => void }) {
  const [tab, setTab] = useState<'timeline' | 'details' | 'matches' | 'messages'>('timeline');
  const wa = (lead.phone ?? '').replace(/\D/g, '');
  return (<>
    <div className="whead">
      <div className="r1"><button className="btn sm back" onClick={onBack}>← Back</button>
        <div style={{ flex: 1, minWidth: 200 }}><h2>{lead.name}</h2>
          <div className="meta"><span className="mono">#{lead.serialNo}</span><span className="mono">{lead.phone ?? 'No phone'}</span>{lead.email && <span>{lead.email}</span>}<span>{SOURCES[lead.source] ?? lead.source}{lead.subSource ? ` · ${lead.subSource}` : ''}</span><span>Created {rel(lead.createdAt)}</span></div></div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}><span className={`pill ${lead.temperature}`}>{lead.temperature} · {lead.score}</span><span className={`st st-${lead.stage}`}>{STAGE_LABEL[lead.stage]}{lead.subStatus ? ` · ${lead.subStatus}` : ''}</span></div>
      </div>
      <div className="qbar">
        <button className="btn primary" onClick={() => onAction('dispo')}>Update status <kbd>D</kbd></button>
        <button className="btn" onClick={() => onAction('call')}>Log call <kbd>C</kbd></button>
        {wa && <a className="btn" href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">WhatsApp ↗</a>}
        <button className="btn" onClick={() => onAction('assign')}>Assign <kbd>A</kbd></button>
        <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5, marginLeft: 'auto' }}>Owner: <b>{userName(lead.ownerId)}</b>{lead.nextActionAt && active(lead) ? <> · Next: <span className={overdue(lead) ? 'due-over' : ''}>{dt(lead.nextActionAt)}</span></> : null}</span>
      </div>
      <div className="tabs">{(['timeline', 'details', 'matches', 'messages'] as const).map((t) => <button key={t} className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
    </div>
    <div className="wscroll">
      {tab === 'timeline' && <Timeline lead={lead} />}
      {tab === 'details' && <Details lead={lead} userName={userName} onSaved={refresh} />}
      {tab === 'matches' && <Matches lead={lead} onShared={() => setTab('messages')} />}
      {tab === 'messages' && <Messages lead={lead} me={me} />}
    </div>
  </>);
}

function Timeline({ lead }: { lead: Lead }) {
  const [items, setItems] = useState<any[]>([]); const [note, setNote] = useState(''); const [conf, setConf] = useState(false);
  const load = useCallback(() => api<any[]>('GET', `/leads/${lead.id}/timeline`).then(setItems).catch(() => {}), [lead.id]);
  useEffect(() => { load(); return onEvent((e) => { if (e.data?.lead_id === lead.id && e.type === 'interaction.created') load(); }); }, [load, lead.id]);
  const add = async () => {
    if (!note.trim()) return;
    try { await api('POST', `/leads/${lead.id}/notes`, { body: note, confidential: conf }); setNote(''); setConf(false); load(); } catch (e) { toast(errMsg(e)); }
  };
  return (<>
    <div className="composer"><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note. @firstname mentions a teammate. Ctrl+Enter saves." aria-label="Note"
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }} />
      <div className="row"><label className="switch muted" style={{ fontSize: 12.5, marginRight: 'auto' }}><input type="checkbox" checked={conf} onChange={(e) => setConf(e.target.checked)} /> Confidential</label><button className="btn primary sm" onClick={add}>Add note</button></div></div>
    <div className="timeline">{items.map((i) => (
      <div className="ti" key={i.id}><span className={`ic ${i.type === 'status_change' ? 'status' : i.type === 'whatsapp' ? 'wa' : i.type === 'call' ? 'call' : ''}`}>{({ call: '☎', whatsapp: '✆', status_change: '◆', note: '✎', assignment: '⇄', reenquiry: '↻', brochure_shared: '⇪', brochure_opened: '👁', task: '✓' } as Record<string, string>)[i.type] ?? '•'}</span>
        <div><div className="tx">{i.is_confidential && <span className="pill">Confidential</span>} {i.summary}</div><div className="when">{i.user_name ?? 'System'} · {dt(i.occurred_at)}</div></div></div>))}
      {items.length === 0 && <p className="muted">No activity yet.</p>}</div>
  </>);
}

function Details({ lead, userName, onSaved }: { lead: Lead; userName: (id: string | null) => string; onSaved: () => void }) {
  const r = lead.requirements ?? {};
  const [f, setF] = useState({ purpose: r.purpose ?? '', offering: r.offering ?? 'any', type: r.types?.[0] ?? '', beds: r.beds ?? '', budgetMin: r.budgetMin ?? '', budgetMax: r.budgetMax ?? '', communities: (r.communities ?? []).join(', ') });
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    try {
      await api('PATCH', `/leads/${lead.id}`, { requirements: { purpose: f.purpose, offering: f.offering, types: f.type ? [f.type] : [], beds: f.beds === '' ? null : Number(f.beds),
        budgetMin: f.budgetMin === '' ? null : Number(f.budgetMin), budgetMax: f.budgetMax === '' ? null : Number(f.budgetMax), communities: f.communities.split(',').map((s: string) => s.trim()).filter(Boolean) } },
      { 'If-Match': `"${lead.version}"` });
      toast('Requirements saved'); onSaved();
    } catch (e) { setErr(errMsg(e)); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (<>
    <div className="card"><div className="hd"><h2>Contact</h2></div><div className="bd"><dl className="dl">
      <dt>Owner</dt><dd>{userName(lead.ownerId)}</dd><dt>First response</dt><dd>{lead.firstResponseAt ? dt(lead.firstResponseAt) : <span className="due-over">Not yet</span>}</dd>
      <dt>Re-enquiries</dt><dd>{lead.reenquiryCount}</dd>{lead.dealValue ? <><dt>Deal value</dt><dd>{money(lead.dealValue)}</dd></> : null}{lead.lostReason && <><dt>Lost reason</dt><dd>{lead.lostReason}</dd></>}
    </dl></div></div>
    <div className="card" style={{ marginTop: 14 }}><div className="hd"><h2>Requirements</h2></div><div className="bd">
      <div className="grid3">
        <div className="field"><label>Purpose</label><select className="in" value={f.purpose} onChange={set('purpose')}><option value="">—</option><option value="buy">Buy</option><option value="rent">Rent</option><option value="invest">Invest</option></select></div>
        <div className="field"><label>Offering</label><select className="in" value={f.offering} onChange={set('offering')}><option value="any">Any</option><option value="ready">Ready</option><option value="off_plan">Off-plan</option></select></div>
        <div className="field"><label>Type</label><select aria-label="Type" className="in" value={f.type} onChange={set('type')}><option value="">Any</option>{['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Plot', 'Office', 'Retail'].map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Bedrooms</label><input aria-label="Bedrooms" className="in" type="number" min={0} value={f.beds} onChange={set('beds')} /></div>
        <div className="field"><label>Budget from (AED)</label><input className="in" type="number" min={0} value={f.budgetMin} onChange={set('budgetMin')} /></div>
        <div className="field"><label>Budget up to (AED)</label><input aria-label="Budget up to (AED)" className="in" type="number" min={0} value={f.budgetMax} onChange={set('budgetMax')} /></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label>Communities (comma separated)</label><input className="in" value={f.communities} onChange={set('communities')} /></div>
      {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Save requirements</button></div>
    </div></div>
  </>);
}

function Matches({ lead, onShared }: { lead: Lead; onShared: () => void }) {
  const [m, setM] = useState<any[] | null>(null); const [pick, setPick] = useState<string[]>([]); const [share, setShare] = useState<any>(null);
  useEffect(() => { api<any[]>('GET', `/leads/${lead.id}/matches`).then(setM).catch((e) => toast(errMsg(e))); }, [lead.id, lead.version]);
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 5 ? [...p, id] : p));
  const doShare = async () => { try { setShare(await api('POST', `/leads/${lead.id}/share`, { propertyIds: pick })); setPick([]); } catch (e) { toast(errMsg(e)); } };
  if (!m) return <p className="muted">Finding matches…</p>;
  if (!m.length) return <div className="empty"><h3>No available units match</h3><p>Widen the budget, bedrooms or communities in Details.</p></div>;
  const wa = (lead.phone ?? '').replace(/\D/g, '');
  return (<>
    {share && <div className="card" style={{ padding: 14, marginBottom: 12 }}><b>Message ready</b><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{share.message}</pre>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{wa && <a className="btn primary sm" target="_blank" rel="noopener noreferrer" href={`https://wa.me/${wa}?text=${encodeURIComponent(share.message)}`}
        onClick={() => api('POST', `/leads/${lead.id}/messages`, { body: share.message, mode: 'log' }).then(onShared)}>Open in WhatsApp ↗</a>}
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(share.message).then(() => toast('Copied'))}>Copy</button></div></div>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}><span className="muted">{m.length} matching units. Tick up to 5 to share a tracked link.</span><span style={{ flex: 1 }} /><button className="btn primary sm" disabled={!pick.length} onClick={doShare}>Share {pick.length || ''}</button></div>
    <div className="card"><div className="bd" style={{ paddingTop: 4 }}>{m.map(({ property: p, score, reasons }) => (
      <div className="match" key={p.id}><input type="checkbox" checked={pick.includes(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.project_name}`} style={{ marginTop: 3 }} />
        <div style={{ minWidth: 0 }}><b>{p.project_name}</b> <span className="muted">· {p.community}</span><div className="muted" style={{ fontSize: 12.5 }}>{p.property_type} · {p.beds === 0 ? 'Studio' : `${p.beds} BR`} · {num(p.area_sqft)} sq ft · {p.offering_type === 'off_plan' ? `Off-plan${p.handover ? ' · ' + p.handover : ''}` : 'Ready'}</div>
          <div className="chips">{reasons.map((r: string) => <span key={r} className="chip ok">{r}</span>)}</div></div>
        <div style={{ textAlign: 'right' }}><div className="mono" style={{ fontWeight: 600 }}>{money(p.price)}</div><span className={`pill ${score >= 75 ? 'good' : score >= 55 ? 'acc' : ''}`}>{score}% match</span></div></div>))}</div></div>
  </>);
}

export function Messages({ lead }: { lead: { id: string; phone: string | null; name: string }; me?: Me }) {
  const [msgs, setMsgs] = useState<any[]>([]); const [body, setBody] = useState('');
  const load = useCallback(() => api<any[]>('GET', `/leads/${lead.id}/messages`).then(setMsgs).catch(() => {}), [lead.id]);
  useEffect(() => { load(); return onEvent((e) => { if (e.data?.lead_id === lead.id && e.type.startsWith('message.')) load(); }); }, [load, lead.id]);
  const send = async (mode: 'send' | 'log', direction: 'outbound' | 'inbound' = 'outbound') => {
    if (!body.trim()) return toast('Type a message first.');
    try { await api('POST', `/leads/${lead.id}/messages`, { body, mode, direction }); setBody(''); load(); } catch (e) { toast(errMsg(e)); }
  };
  const wa = (lead.phone ?? '').replace(/\D/g, '');
  return (<div>
    <div className="msgs" style={{ padding: '0 0 12px' }}>{msgs.map((m) => <div key={m.id} className={`msg ${m.direction === 'inbound' ? 'in' : 'out'}`}>{m.body}<div className="m">{m.direction === 'inbound' ? lead.name.split(' ')[0] : m.sent_by_name} · {dt(m.created_at)} · {m.status}</div></div>)}
      {!msgs.length && <p className="muted">No messages yet.</p>}</div>
    <div className="wacomp" style={{ border: '1px solid var(--line)', borderRadius: 10 }}>
      <textarea className="in" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type a message" aria-label="Message" />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn primary sm" onClick={() => send('send')}>Send via WhatsApp API</button>
        {wa && <a className="btn sm" href={`https://wa.me/${wa}?text=${encodeURIComponent(body)}`} target="_blank" rel="noopener noreferrer" onClick={() => send('log')}>Open in WhatsApp ↗ (logs it)</a>}
        <button className="btn sm" onClick={() => send('log', 'inbound')}>Log their reply</button>
      </div></div>
  </div>);
}

function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const element = ref.current;
    if (element && !element.contains(document.activeElement)) element.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close.current(); }
      if (e.key !== 'Tab' || !element) return;
      const nodes = element.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
      const first = nodes[0], last = nodes[nodes.length-1];
      if (first && last && (document.activeElement === element || !element.contains(document.activeElement) || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last))) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    };
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return ref;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return <div className="ov" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <div className="mh"><h3>{title}</h3><button className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={18}/></button></div><div className="mb">{children}</div>{footer && <div className="mf">{footer}</div>}</div></div>;
}

function DispositionModal({ lead, dispos, users, me, onClose, onSaved }: { lead: Lead; dispos: Dispo[]; users: User[]; me: Me; onClose: () => void; onSaved: (next: boolean) => void }) {
  const [key, setKey] = useState(dispos.find((d) => d.stage === lead.stage && !d.isLost)?.key ?? 'callback');
  const d = dispos.find((x) => x.key === key);
  const [sub, setSub] = useState(''); const [next, setNext] = useState(() => { const t = new Date(Date.now() + 86400_000); t.setMinutes(0, 0, 0); return toLocalInput(t); });
  const [deal, setDeal] = useState(''); const [note, setNote] = useState(''); const [assign, setAssign] = useState(lead.ownerId ?? ''); const [err, setErr] = useState('');
  const [props, setProps] = useState<any[]>([]); const [prop, setProp] = useState('');
  const isMgr = ['owner', 'admin', 'manager'].includes(me.role);
  useEffect(() => { setSub(d?.subStatuses[0] ?? ''); }, [key]); // eslint-disable-line
  useEffect(() => { api<any[]>('GET', '/properties?status=available').then(setProps).catch(() => {}); }, []);
  const save = async (goNext: boolean) => {
    if (!d) return; setErr('');
    try {
      await api('POST', `/leads/${lead.id}/disposition`, {
        disposition: key, subStatus: sub, nextActionAt: d.requiresNextAction || d.allowsNextAction ? new Date(next).toISOString() : null,
        dealValue: d.requiresDealValue ? Number(deal) : null, propertyId: key === 'site_visit' && prop ? prop : null, note: note || null,
        ...(isMgr && assign !== (lead.ownerId ?? '') ? { assignTo: assign || null } : {}),
      }, { 'If-Match': `"${lead.version}"` });
      toast(`Saved: ${d.label}`); onSaved(goNext);
    } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
      if (!typing && /^[1-7]$/.test(e.key) && dispos[+e.key - 1]) { e.preventDefault(); setKey(dispos[+e.key - 1].key); }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); save(true); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(false); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  return <Modal title={`Update status · ${lead.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn" onClick={() => save(false)}>Save & close</button><button className="btn primary" onClick={() => save(true)}>Save & next <kbd>⇧↵</kbd></button></>}>
    <div className="dchips">{dispos.map((x, i) => <button key={x.key} type="button" className={`dchip ${x.isLost ? 'lost' : ''}`} aria-pressed={key === x.key} onClick={() => setKey(x.key)}><kbd>{i + 1}</kbd>{x.label}</button>)}</div>
    <div className="grid2">
      <div className="field"><label>{d?.isLost ? 'Reason' : 'Sub-status'}</label><select className="in" value={sub} onChange={(e) => setSub(e.target.value)}>{d?.subStatuses.map((s) => <option key={s}>{s}</option>)}</select></div>
      {(d?.requiresNextAction || d?.allowsNextAction) && <div className="field"><label>Next action</label><input aria-label="Next action" className="in" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} /></div>}
      {d?.requiresDealValue && <div className="field"><label>Deal value (AED)</label><input aria-label="Deal value (AED)" className="in" type="number" min={0} value={deal} onChange={(e) => setDeal(e.target.value)} /></div>}
    </div>
    {key === 'site_visit' && <div className="field"><label>Unit</label><select className="in" value={prop} onChange={(e) => setProp(e.target.value)}><option value="">Not decided</option>{props.map((p) => <option key={p.id} value={p.id}>{p.project_name} · {p.reference} · {money(p.price)}</option>)}</select></div>}
    {isMgr && <div className="field"><label>Assigned to</label><select className="in" value={assign} onChange={(e) => setAssign(e.target.value)}><option value="">Unassigned</option>{users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></div>}
    <div className="field"><label>Note</label><textarea className="in" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened on this contact?" /></div>
    {err && <div className="err">{err}</div>}
  </Modal>;
}

function CallModal({ lead, onClose, onSaved }: { lead: Lead; onClose: () => void; onSaved: (then: boolean) => void }) {
  const [outcome, setOutcome] = useState('connected'); const [dir, setDir] = useState<'outbound' | 'inbound'>('outbound'); const [mins, setMins] = useState('2'); const [notes, setNotes] = useState(''); const [then, setThen] = useState(true);
  const save = async () => { try { await api('POST', `/leads/${lead.id}/calls`, { direction: dir, outcome, durationSec: Math.round(Number(mins) * 60), notes: notes || undefined }); toast('Call logged'); onSaved(then); } catch (e) { toast(errMsg(e)); } };
  return <Modal title={`Log call · ${lead.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save call</button></>}>
    <div className="dchips">{[['connected', 'Connected'], ['no_answer', 'No answer'], ['busy', 'Busy'], ['switched_off', 'Switched off'], ['wrong_number', 'Wrong number']].map(([k, l]) => <button key={k} className="dchip" aria-pressed={outcome === k} onClick={() => setOutcome(k)}>{l}</button>)}</div>
    <div className="grid2"><div className="field"><label>Direction</label><select aria-label="Direction" className="in" value={dir} onChange={(e) => setDir(e.target.value as any)}><option value="outbound">Outgoing</option><option value="inbound">Incoming</option></select></div>
      <div className="field"><label>Duration (min)</label><input aria-label="Duration (min)" className="in" type="number" min={0} step={0.5} value={mins} onChange={(e) => setMins(e.target.value)} /></div></div>
    <div className="field"><label>Summary</label><textarea aria-label="Summary" className="in" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    <label className="switch"><input type="checkbox" checked={then} onChange={(e) => setThen(e.target.checked)} /> Update status next</label>
  </Modal>;
}

function AssignModal({ lead, users, me, onClose, onSaved }: { lead: Lead; users: User[]; me: Me; onClose: () => void; onSaved: () => void }) {
  const isMgr = ['owner', 'admin', 'manager'].includes(me.role);
  const go = async (id: string | null) => { try { await api('POST', `/leads/${lead.id}/assign`, { userId: id }); toast('Assigned'); onSaved(); } catch (e) { toast(errMsg(e)); } };
  const list = isMgr ? users.filter((u) => u.is_active && ['agent', 'manager'].includes(u.role)) : users.filter((u) => u.id === me.id);
  return <Modal title={`Assign ${lead.name}`} onClose={onClose}>
    {!isMgr && <p className="muted">Agents can claim unassigned leads for themselves.</p>}
    <div className="dchips" style={{ gridTemplateColumns: '1fr' }}>{list.map((u) => <button key={u.id} className="dchip" aria-pressed={lead.ownerId === u.id} onClick={() => go(u.id)}><span style={{ flex: 1 }}>{u.full_name}</span><span className="muted mono">{u.open_leads} open</span>{u.is_clocked_in ? <span className="pill good">On</span> : <span className="pill">Off</span>}</button>)}</div>
    {isMgr && <button className="btn" onClick={() => go(null)}>Move to unassigned pool</button>}
  </Modal>;
}

function NewLeadModal({ users, onClose, onSaved }: { users: User[]; onClose: () => void; onSaved: (id: string) => void }) {
  const dialogRef = useDialog<HTMLFormElement>(onClose);
  const [f, setF] = useState({ name: '', phone: '', email: '', source: 'bayut', subSource: '', owner: 'auto', budgetMax: '', beds: '', type: '', community: '', note: '' });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    try {
      const r = await api<{ lead: Lead; reenquiry: boolean }>('POST', '/leads', {
        name: f.name, phone: f.phone || null, email: f.email || null, source: f.source, subSource: f.subSource || null, note: f.note || null,
        ownerId: f.owner === 'auto' ? 'auto' : f.owner || null,
        requirements: { budgetMax: f.budgetMax ? Number(f.budgetMax) : null, beds: f.beds === '' ? null : Number(f.beds), types: f.type ? [f.type] : [], communities: f.community ? [f.community] : [] },
      });
      toast(r.reenquiry ? 'Phone already exists: logged as a re-enquiry on the existing lead' : 'Lead created'); onSaved(r.lead.id);
    } catch (e2) { setErr(errMsg(e2)); }
  };
  return <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><form className="modal wide" onSubmit={save} ref={dialogRef} role="dialog" aria-modal="true" aria-label="New lead" tabIndex={-1}>
    <div className="mh"><h3>New lead</h3><button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={18}/></button></div><div className="mb">
      <div className="grid2">
        <div className="field"><label>Full name</label><input aria-label="Full name" className="in" required autoFocus value={f.name} onChange={set('name')} /></div>
        <div className="field"><label>Phone</label><input aria-label="Phone" className="in" value={f.phone} onChange={set('phone')} placeholder="+971 50 123 4567" /></div>
        <div className="field"><label>Email</label><input aria-label="Email" className="in" type="email" value={f.email} onChange={set('email')} /></div>
        <div className="field"><label>Source</label><select aria-label="Source" className="in" value={f.source} onChange={set('source')}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field"><label>Sub-source</label><input aria-label="Sub-source" className="in" value={f.subSource} onChange={set('subSource')} /></div>
        <div className="field"><label>Assign to</label><select aria-label="Assign to" className="in" value={f.owner} onChange={set('owner')}><option value="auto">Auto-assign by rules</option><option value="">Unassigned</option>{users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></div>
        <div className="field"><label>Budget up to (AED)</label><input aria-label="Budget up to (AED)" className="in" type="number" value={f.budgetMax} onChange={set('budgetMax')} /></div>
        <div className="field"><label>Bedrooms</label><input aria-label="Bedrooms" className="in" type="number" min={0} value={f.beds} onChange={set('beds')} /></div>
        <div className="field"><label>Type</label><select aria-label="Type" className="in" value={f.type} onChange={set('type')}><option value="">Any</option>{['Apartment', 'Villa', 'Townhouse', 'Penthouse'].map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Community</label><input aria-label="Community" className="in" value={f.community} onChange={set('community')} /></div>
      </div>
      <div className="field"><label>First note</label><textarea aria-label="First note" className="in" value={f.note} onChange={set('note')} /></div>
      {err && <div className="err">{err}</div>}
    </div><div className="mf"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" type="submit">Create lead</button></div></form></div>;
}
