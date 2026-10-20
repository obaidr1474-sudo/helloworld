import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { errMsg, toast, type Me, type User } from '../App';

export function Team({ me, users, reload }: { me: Me; users: User[]; reload: () => void }) {
  const isAdmin = ['owner', 'admin'].includes(me.role);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'agent', capacity: '' });
  const [rules, setRules] = useState<any[]>([]); const [settings, setSettings] = useState<any>(null);
  useEffect(() => { if (isAdmin) { api<any[]>('GET', '/allocation-rules').then(setRules); api('GET', '/settings').then(setSettings); } }, [isAdmin]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api('POST', '/users', { name: f.name, email: f.email, password: f.password, role: f.role, capacity: f.capacity ? Number(f.capacity) : null }); setF({ name: '', email: '', password: '', role: 'agent', capacity: '' }); toast('Teammate added'); reload(); }
    catch (e2) { toast(errMsg(e2)); }
  };
  const toggleActive = async (u: User) => { try { await api('PATCH', `/users/${u.id}`, { isActive: !u.is_active }); reload(); } catch (e) { toast(errMsg(e)); } };
  const saveRule = async (r: any, strategy: string, onlyClockedIn: boolean) => {
    try { const def = { ...r.definition, strategy, pool: { ...r.definition.pool, onlyClockedIn } }; await api('PUT', `/allocation-rules/${r.id}`, { name: r.name, priority: r.priority, isEnabled: r.is_enabled, definition: def }); setRules(await api('GET', '/allocation-rules')); toast('Rule saved'); }
    catch (e) { toast(errMsg(e)); }
  };
  const saveSla = async (v: number, auto: boolean) => { try { setSettings({ ...settings, settings: await api('PATCH', '/settings', { sla_minutes: v, sla_auto_reassign: auto }) }); toast('Saved'); } catch (e) { toast(errMsg(e)); } };
  return <div className="pad"><div className="dash">
    <div className="card c8"><div className="hd"><h2>Team</h2></div><div className="bd"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Role</th><th>Shift</th><th className="r">Open leads</th><th className="r">Capacity</th><th /></tr></thead><tbody>
      {users.map((u) => <tr key={u.id}><td><b>{u.full_name}</b><div className="muted" style={{ fontSize: 12 }}>{u.email}</div></td><td>{u.role}</td><td>{u.is_clocked_in ? <span className="pill good">On</span> : <span className="pill">Off</span>}</td><td className="r">{u.open_leads}</td><td className="r">{u.capacity_max_open_leads ?? '∞'}</td>
        <td className="r">{isAdmin && u.id !== me.id && <button className="btn sm" onClick={() => toggleActive(u)}>{u.is_active ? 'Deactivate' : 'Reactivate'}</button>}</td></tr>)}
    </tbody></table></div>
    {isAdmin && <form onSubmit={add} className="grid3" style={{ marginTop: 14, alignItems: 'end' }}>
      <div className="field"><label>Name</label><input className="in" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label>Email</label><input className="in" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <div className="field"><label>Initial password</label><input className="in" type="password" minLength={10} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
      <div className="field"><label>Role</label><select className="in" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['agent', 'manager', 'listing_manager', 'admin', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select></div>
      <div className="field"><label>Max open leads</label><input className="in" type="number" min={0} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></div>
      <button className="btn primary" type="submit">Add teammate</button></form>}
    <p className="muted" style={{ fontSize: 12.5 }}>Deactivating someone returns their open leads to the unassigned pool.</p></div></div>
    {isAdmin && <div className="card c4"><div className="hd"><h2>Allocation & SLA</h2></div><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rules.map((r) => <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><b>{r.name}</b>
        <select className="in" value={r.definition.strategy} onChange={(e) => saveRule(r, e.target.value, !!r.definition.pool.onlyClockedIn)}><option value="round_robin">Round robin</option><option value="least_loaded">Least loaded</option><option value="manual_pool">Leave unassigned</option></select>
        <label className="switch"><input type="checkbox" checked={!!r.definition.pool.onlyClockedIn} onChange={(e) => saveRule(r, r.definition.strategy, e.target.checked)} /> Only clocked-in agents</label></div>)}
      {!rules.length && <p className="muted">The default round-robin rule is created with your first lead.</p>}
      {settings && <><div className="field"><label>First-response SLA (minutes)</label><input className="in" type="number" min={1} defaultValue={settings.settings.sla_minutes ?? 15} onBlur={(e) => saveSla(Number(e.target.value), !!settings.settings.sla_auto_reassign)} /></div>
        <label className="switch"><input type="checkbox" checked={!!settings.settings.sla_auto_reassign} onChange={(e) => saveSla(settings.settings.sla_minutes ?? 15, e.target.checked)} /> Reassign on SLA breach</label>
        <div className="field"><label>Intake webhook secret</label><input className="in mono" readOnly value={settings.intake_secret} onFocus={(e) => e.target.select()} /></div></>}
    </div></div>}
  </div></div>;
}
