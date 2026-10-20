import { useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { onEvent } from '../lib/realtime';
import { dt, rel } from '../lib/format';
import { errMsg, toast, type Me, type User } from '../App';

export function Tasks({ me, users, openLead }: { me: Me; users: User[]; openLead: (id: string) => void }) {
  const [queue, setQueue] = useState<'overdue' | 'today' | 'upcoming' | 'done'>('overdue');
  const [assignee, setAssignee] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const isMgr = ['owner', 'admin', 'manager'].includes(me.role);
  const load = () => api<any[]>('GET', '/tasks' + qs({ queue, assigneeId: assignee || undefined })).then(setRows).catch((e) => toast(errMsg(e)));
  useEffect(() => { load(); return onEvent((e) => { if (e.type.startsWith('task.')) load(); }); }, [queue, assignee]); // eslint-disable-line
  const toggle = async (t: any) => { try { await api('POST', `/tasks/${t.id}/${t.status === 'done' ? 'reopen' : 'complete'}`, {}); load(); } catch (e) { toast(errMsg(e)); } };
  return <div className="pad">
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
      <div className="tabs">{(['overdue', 'today', 'upcoming', 'done'] as const).map((k) => <button key={k} className="tab" aria-selected={queue === k} onClick={() => setQueue(k)}>{k[0].toUpperCase() + k.slice(1)}</button>)}</div>
      <span style={{ flex: 1 }} />
      {isMgr && <select className="in" style={{ width: 'auto' }} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Agent"><option value="">All agents</option>{users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>}
    </div>
    {rows.length ? <div className="card"><div className="tbl-wrap"><table className="tbl"><thead><tr><th /><th>Task</th><th>Lead</th><th>Agent</th><th>Due</th></tr></thead><tbody>
      {rows.map((t) => { const od = t.status === 'open' && new Date(t.due_at) < new Date(); return <tr key={t.id}>
        <td><input type="checkbox" checked={t.status === 'done'} onChange={() => toggle(t)} aria-label="Mark done" /></td>
        <td style={t.status === 'done' ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}><span className="pill">{t.type.replace('_', ' ')}</span> {t.title}</td>
        <td>{t.lead_id ? <button className="btn ghost sm" style={{ color: 'var(--link)' }} onClick={() => openLead(t.lead_id)}>{t.lead_name}</button> : '—'}</td>
        <td>{t.assignee_name}</td><td className={od ? 'due-over' : ''}>{dt(t.due_at)} <span className="muted">{t.status === 'open' ? rel(t.due_at) : ''}</span></td></tr>; })}
    </tbody></table></div></div> : <div className="empty"><h3>Nothing here</h3><p>Tasks are created automatically when a status update sets a next action.</p></div>}
  </div>;
}
