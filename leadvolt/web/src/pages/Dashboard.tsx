import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../lib/api';
import { onEvent } from '../lib/realtime';
import { money,rel,SOURCES,dateInZone,dateStartInZone } from '../lib/format';
import { errMsg, type Me, type User } from '../App';
import { Icon } from '../components/Icon';
import type { LeadRequest } from './Leads';

const COLORS = ['#ff8255', '#7775df', '#54b9a2', '#62a4ea', '#e2b85c', '#d687c3', '#8c9aaf'];
interface Overview {
  totals: Record<string, number>;
  sources: { source: string; leads: number; booked: number; value: number }[];
  funnel: { stage: string; count: number }[];
  agents: { id: string; full_name: string; is_clocked_in: boolean; leads: number; active: number; calls: number; visit_plus: number; booked: number; value: number; conversion: number; overdue: number }[];
  slaBreaches: { id: string; full_name: string; source: string; created_at: string }[];
}

export function Dashboard({ me, users, openLead, browseLeads }: { me: Me; users: User[]; openLead: (id: string) => void; browseLeads: (filters?: LeadRequest['filters']) => void }) {
  const [period, setPeriod] = useState<'all' | '30d' | '7d' | 'today'>('all');
  const [agent, setAgent] = useState('');
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const manager = ['owner', 'admin', 'manager', 'viewer'].includes(me.role);
  const from = useMemo(() => period === 'all' ? undefined : period === 'today' ? dateStartInZone(dateInZone(new Date().toISOString(),me.timezone),me.timezone) : new Date(Date.now() - (period === '7d' ? 7 : 30) * 864e5).toISOString(), [period,retry,me.timezone]);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => api<Overview>('GET', '/analytics/overview' + qs({ from, agentIds: agent })).then(r => { if (!controller.signal.aborted) { setD(r); setError(''); } }).catch(e => { if (!controller.signal.aborted) setError(errMsg(e)); });
    setD(null); load();
    let t: number | undefined;
    const off = onEvent((e) => { if(e.type==='sync.required'||e.type.startsWith('lead.') || e.type === 'deal.booked' || e.type === 'sla.breached') { clearTimeout(t); t = window.setTimeout(load, 500); } });
    return () => { controller.abort(); off(); clearTimeout(t); };
  // The period defines a single time boundary for each request, including live refreshes.
  }, [period, agent, retry]);
  const browse = (filters: LeadRequest['filters'] = {}) => browseLeads({ queue: 'all', ownerId: agent, createdFrom: from, ...filters });
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone:me.timezone||'Asia/Dubai' }).format(new Date());
  if (error) return <div className="empty"><h3>We couldn’t load your dashboard</h3><p role="alert">{error}</p><button className="btn" onClick={() => setRetry(n => n + 1)}>Try again</button></div>;
  const t = d?.totals;
  const kpis = t ? [
    { label: 'Total leads', value: t.leads, sub: `${t.active} active opportunities`, icon: 'leads', color: 'purple', filters: {} },
    { label: 'New leads', value: t.untouched, sub: 'Waiting for a first conversation', icon: 'bolt', color: 'blue', filters: { queue: 'new' } },
    { label: 'Scheduled follow-ups', value: t.scheduled, sub: 'Keep the conversation moving', icon: 'tasks', color: 'teal', filters: { queue: 'scheduled' } },
    { label: 'Overdue follow-ups', value: t.overdue, sub: t.overdue ? 'A little attention goes a long way' : 'You’re all caught up', icon: 'clock', color: 'orange', filters: { queue: 'overdue' } },
  ] : [];
  let angle = 0;
  const gradient = d?.sources.map((s, i) => { const start = angle; angle += s.leads / (d.totals.leads || 1) * 360; return `${COLORS[i % COLORS.length]} ${start}deg ${angle}deg`; }).join(', ');
  return <div className="pad dashboard-page">
    <div className="page-heading"><div><div className="eyebrow">YOUR BUSINESS AT A GLANCE</div><h1>Hello, {me.full_name.split(' ')[0]} <span className="greeting-dot">✦</span></h1><p>Here’s what’s happening with your pipeline.</p></div><div className="heading-date"><Icon name="tasks" size={16}/>{date}</div></div>
    <div className="dashboard-toolbar"><div className="segmented" aria-label="Dashboard period">{(['all', '30d', '7d', 'today'] as const).map(p => <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>{{ all: 'All time', '30d': '30 days', '7d': '7 days', today: 'Today' }[p]}</button>)}</div><div className="grow"/>{manager && <select className="in agent-filter" value={agent} onChange={e => setAgent(e.target.value)} aria-label="Dashboard agent"><option value="">All agents</option>{users.filter(u => u.is_active).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>}<button className="icon-btn bordered" aria-label="Refresh dashboard" onClick={() => setRetry(n => n + 1)}><Icon name="refresh" size={17}/></button></div>
    {!d || !t ? <div className="dashboard-loading" role="status"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/><p>Loading your workspace…</p></div> : <>
      <div className="overview-kpis">{kpis.map(k => <button key={k.label} className={`overview-kpi ${k.color}`} onClick={() => browse(k.filters)}><div className="kpi-top"><span>{k.label}</span><span className="metric-icon"><Icon name={k.icon} size={20}/></span></div><strong>{k.value ?? 0}</strong><div className="kpi-bottom"><span>{k.sub}</span><Icon name="arrow" size={16}/></div></button>)}</div>
      <div className="pipeline-strip"><div><span className="eyebrow">PIPELINE SNAPSHOT</span><p>A clear view of every opportunity</p></div>{[{label:'Contacted',key:'contacted',icon:'phone'}, {label:'Meetings',key:'meeting',icon:'team'}, {label:'Site visits',key:'site_visit',icon:'inventory'}, {label:'EOI',key:'eoi',icon:'target'}, {label:'Booked',key:'booked',icon:'check'}].map(s => <button key={s.key} onClick={() => browse({stage:s.key})}><span className={`pipeline-icon ${s.key}`}><Icon name={s.icon} size={17}/></span><span>{s.label}<b>{t[s.key] ?? 0}</b></span></button>)}</div>
      <div className="dashboard-grid">
        <section className="card source-card"><div className="hd"><div><h2>Where leads come from</h2><p className="card-subtitle">Your source mix, at a glance</p></div><span className="subtle-tag">{d.sources.length} sources</span></div><div className="source-content"><div className="donut" style={{background: gradient ? `conic-gradient(${gradient})` : 'var(--line)'}} role="img" aria-label={d.sources.map(s => `${SOURCES[s.source] ?? s.source}: ${s.leads}`).join(', ') || 'No leads yet'}><div><strong>{t.leads}</strong><span>Total leads</span></div></div><div className="source-legend">{d.sources.map((s,i) => <button key={s.source} onClick={() => browse({source:s.source})}><i style={{background:COLORS[i % COLORS.length]}}/><span>{SOURCES[s.source] ?? s.source}</span><b>{s.leads}</b><small>{Math.round(s.leads/(t.leads||1)*100)}%</small></button>)}{!d.sources.length && <p className="muted">Add your first lead to see the source mix.</p>}</div></div></section>
        <section className="card funnel-card"><div className="hd"><div><h2>Conversion funnel</h2><p className="card-subtitle">From the first hello to a closed deal</p></div><span className="subtle-tag">{t.leads ? (t.booked/t.leads*100).toFixed(1) : 0}% booked</span></div><div className="conversion-funnel">{d.funnel.map((f,i) => <div className="funnel-row" key={f.stage}><div className="funnel-label"><i style={{background:COLORS[i]}}/>{f.stage}<strong>{f.count}</strong></div><div className="funnel-track"><span style={{width:`${f.count/(t.leads||1)*100}%`,background:COLORS[i]}}/></div></div>)}</div><div className="funnel-foot"><Icon name="wallet" size={18}/><span>Booked value</span><strong>{money(t.booked_value)}</strong></div></section>
        <section className="card performance-card"><div className="hd"><div><h2>Your team, moving things forward</h2><p className="card-subtitle">Agent performance for the selected lead cohort</p></div><span className="subtle-tag">{d.agents.filter(a=>a.is_clocked_in).length} on shift</span></div><div className="tbl-wrap"><table className="tbl performance-table"><thead><tr><th>Agent</th><th className="r">Leads</th><th className="r">Active</th><th className="r">Calls¹</th><th className="r">Visits+</th><th className="r">Booked</th><th className="r">Deal value</th><th className="r">Conversion</th></tr></thead><tbody>{d.agents.map((a,i)=><tr key={a.id}><td><button className="agent-link" onClick={()=>browse({ownerId:a.id})}><span className={`avatar avatar-${i%4}`}>{a.full_name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><span><b>{a.full_name}</b><small><i className={a.is_clocked_in?'online':'offline'}/>{a.is_clocked_in?'On shift':'Off shift'}</small></span></button></td><td className="r">{a.leads}</td><td className="r">{a.active}</td><td className="r">{a.calls}</td><td className="r">{a.visit_plus}</td><td className="r"><span className="pill good">{a.booked}</span></td><td className="r">{money(a.value)}</td><td className="r"><span className="conversion-number">{(a.conversion*100).toFixed(1)}%</span></td></tr>)}</tbody></table>{!d.agents.length&&<div className="empty">No agents match this view.</div>}</div><div className="table-note">¹ Calls logged by each agent on leads in the selected cohort.</div></section>
        <section className="card attention-card"><div className="hd"><div><h2>A little attention needed</h2><p className="card-subtitle">New leads still awaiting their first response</p></div><Icon name="clock" size={19}/></div><div className="attention-list">{d.slaBreaches.slice(0,5).map(l=><button key={l.id} onClick={()=>openLead(l.id)}><span className="attention-dot"/><span><b>{l.full_name}</b><small>{SOURCES[l.source]??l.source} · {rel(l.created_at)}</small></span><Icon name="chevron" size={16}/></button>)}{!d.slaBreaches.length&&<div className="all-clear"><span><Icon name="check" size={23}/></span><b>All clear here</b><p>No missed first-response deadlines in this view.</p></div>}</div><button className="card-link" onClick={()=>browse({scope:'sla'})}>View first-response queue <Icon name="arrow" size={16}/></button></section>
      </div>
    </>}
  </div>;
}
