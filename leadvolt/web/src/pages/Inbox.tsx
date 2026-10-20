import { useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { onEvent } from '../lib/realtime';
import { rel } from '../lib/format';
import type { Me } from '../App';
import { Messages } from './Leads';

export function Inbox({ me, openLead }: { me: Me; openLead: (id: string) => void }) {
  const [filter, setFilter] = useState<'all' | 'mine' | 'waiting'>('all');
  const [rows, setRows] = useState<any[]>([]); const [sel, setSel] = useState<any | null>(null);
  const load = () => api<any[]>('GET', '/inbox' + qs({ filter })).then(setRows).catch(() => {});
  useEffect(() => { load(); return onEvent((e) => { if(e.type==='sync.required'||e.type.startsWith('message.')) load(); }); }, [filter]); // eslint-disable-line
  return <div className={`inbox ${sel ? 'has-sel' : ''}`}>
    <div className="ibl"><div className="lbar"><div className="tabs">{(['all', 'mine', 'waiting'] as const).map((k) => <button key={k} className="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{{ all: 'All', mine: 'Mine', waiting: 'Waiting on us' }[k]}</button>)}</div></div>
      {rows.map((r) => <div key={r.lead_id} className="lrow" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }} aria-selected={sel?.lead_id === r.lead_id} onClick={() => setSel(r)}>
        <div style={{ minWidth: 0 }}><div className="nm">{r.full_name}</div><div className="sub">{r.direction === 'outbound' ? 'You: ' : ''}{r.body}</div></div>
        <div className="rt"><span className="muted">{rel(r.created_at)}</span>{r.direction === 'inbound' && <span className="pill good">Reply</span>}</div></div>)}
      {!rows.length && <div className="empty"><h3>No conversations</h3><p>Messages appear here when leads write in or agents log them.</p></div>}</div>
    <div className="thread">{sel ? <div className="wscroll"><div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}><button className="btn sm back" onClick={() => setSel(null)}>← Back</button><h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>{sel.full_name}</h2><button className="btn sm" onClick={() => openLead(sel.lead_id)}>Open lead</button></div>
      <Messages lead={{ id: sel.lead_id, phone:sel.phone_e164,name:sel.full_name }} me={me} /></div> : <div className="empty" style={{ margin: 'auto' }}><h3>Pick a conversation</h3></div>}</div>
  </div>;
}
