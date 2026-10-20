import { useEffect, useState } from 'react';
import { Modal } from './Leads';
import { api } from '../lib/api';
import { errMsg, toast, type Me, type User } from '../App';

export function Team({ me, users, reload }: { me: Me; users: User[]; reload: () => void }) {
  const isAdmin = ['owner', 'admin'].includes(me.role);
  const [f,setF]=useState({name:'',email:'',password:'',role:'agent',capacity:'',brn:''});
  const [secret,setSecret]=useState(''),[rotate,setRotate]=useState(false),[secretBusy,setSecretBusy]=useState(false);
  const [rules, setRules] = useState<any[]>([]); const [settings, setSettings] = useState<any>(null);
  useEffect(() => { if (isAdmin) { api<any[]>('GET', '/allocation-rules').then(setRules).catch(e=>toast(errMsg(e))); api('GET', '/settings').then(setSettings).catch(e=>toast(errMsg(e))); } }, [isAdmin]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api('POST', '/users', { name: f.name, email: f.email, password: f.password, role: f.role, capacity:f.capacity?Number(f.capacity):null,brokerRegistrationNumber:f.brn||null }); setF({ name: '', email: '', password: '', role: 'agent', capacity:'',brn:''});toast('Teammate added'); reload(); }
    catch (e2) { toast(errMsg(e2)); }
  };
  const toggleActive = async (u: User) => { try { await api('PATCH', `/users/${u.id}`, { isActive: !u.is_active }); reload(); } catch (e) { toast(errMsg(e)); } };
  const saveRule = async (r: any, strategy: string, onlyClockedIn: boolean) => {
    try { const def = { ...r.definition, strategy, pool: { ...r.definition.pool, onlyClockedIn } }; await api('PUT', `/allocation-rules/${r.id}`, { name: r.name, priority: r.priority, isEnabled: r.is_enabled, definition: def }); setRules(await api('GET', '/allocation-rules')); toast('Rule saved'); }
    catch (e) { toast(errMsg(e)); }
  };
  const saveSla = async (v: number, auto: boolean) => { try { setSettings({ ...settings, settings: await api('PATCH', '/settings', { sla_minutes: v, sla_auto_reassign: auto }) }); toast('Saved'); } catch (e) { toast(errMsg(e)); } };
  return <div className="pad"><div className="dash">
    <div className="card c8"><div className="hd"><h2>Team</h2></div><div className="bd"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Role / BRN</th><th>Shift</th><th className="r">Open leads</th><th className="r">Capacity</th><th /></tr></thead><tbody>
      {users.map((u) => <tr key={u.id}><td><b>{u.full_name}</b><div className="muted" style={{ fontSize: 12 }}>{u.email}</div></td><td>{u.role}<small style={{display:'block',color:'var(--muted)',fontSize:11}}>{u.broker_registration_number||'BRN not recorded'}</small></td><td>{u.is_clocked_in ? <span className="pill good">On</span> : <span className="pill">Off</span>}</td><td className="r">{u.open_leads}</td><td className="r">{u.capacity_max_open_leads ?? '∞'}</td>
        <td className="r">{isAdmin && u.id !== me.id && <button className="btn sm" onClick={() => toggleActive(u)}>{u.is_active ? 'Deactivate' : 'Reactivate'}</button>}</td></tr>)}
    </tbody></table></div>
    {isAdmin && <form onSubmit={add} className="grid3" style={{ marginTop: 14, alignItems: 'end' }}>
      <div className="field"><label>Name</label><input className="in" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label>Email</label><input className="in" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <div className="field"><label>Initial password</label><input className="in" type="password" minLength={12} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
      <div className="field"><label>Role</label><select className="in" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{['agent', 'manager', 'listing_manager', 'admin', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select></div>
      <div className="field"><label>Max open leads</label><input className="in" type="number" min={0} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></div>
      <div className="field"><label>BRN (optional)</label><input className="in" value={f.brn} onChange={e=>setF({...f,brn:e.target.value})}/></div><button className="btn primary" type="submit">Add teammate</button></form>}
    <p className="muted" style={{ fontSize: 12.5 }}>Deactivating someone returns their open leads to the unassigned pool.</p></div></div>
    {isAdmin && <div className="card c4"><div className="hd"><h2>Allocation & SLA</h2></div><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rules.map((r) => <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}><b>{r.name}</b>
        <select className="in" value={r.definition.strategy} onChange={(e) => saveRule(r, e.target.value, !!r.definition.pool.onlyClockedIn)}><option value="round_robin">Round robin</option><option value="least_loaded">Least loaded</option><option value="manual_pool">Leave unassigned</option></select>
        <label className="switch"><input type="checkbox" checked={!!r.definition.pool.onlyClockedIn} onChange={(e) => saveRule(r, r.definition.strategy, e.target.checked)} /> Only clocked-in agents</label></div>)}
      <p className="modal-explanation">These general rules apply to enquiries without listing ownership routing. Bayut listing enquiries stay with their mapped agent.</p>
      {!rules.length && <p className="muted">The default round-robin rule is created with your first lead.</p>}
      {settings && <><div className="field"><label>First-response SLA (minutes)</label><input className="in" type="number" min={1} defaultValue={settings.settings.sla_minutes ?? 15} onBlur={(e) => saveSla(Number(e.target.value), !!settings.settings.sla_auto_reassign)} /></div>
        <label className="switch"><input type="checkbox" checked={!!settings.settings.sla_auto_reassign} onChange={(e) => saveSla(settings.settings.sla_minutes ?? 15, e.target.checked)} /> Reassign non-listing leads on SLA breach</label>
        <div className="field"><label>Intake signing key</label>{secret?<input className="in mono" readOnly aria-label="Revealed intake signing key" value={secret} onFocus={e=>e.target.select()}/>:<p className="modal-explanation">Hidden. Access is recorded in audit history.</p>}<div className="row-actions"><button className="btn sm" disabled={secretBusy} onClick={async()=>{setSecretBusy(true);try{const r=await api('POST','/settings/intake-secret/reveal',{});setSecret(r.secret);window.setTimeout(()=>setSecret(''),60000);}catch(e){toast(errMsg(e));}finally{setSecretBusy(false);}}}>Reveal signing key</button>{secret&&<button className="btn sm" onClick={()=>setSecret('')}>Hide</button>}<button className="btn sm" onClick={()=>setRotate(true)}>Rotate key</button></div></div></>}
    </div></div>}
    {rotate&&<Modal title="Rotate intake signing key" onClose={()=>setRotate(false)} footer={<><button className="btn" onClick={()=>setRotate(false)}>Cancel</button><button className="btn danger" disabled={secretBusy} onClick={async()=>{setSecretBusy(true);try{const r=await api('POST','/settings/intake-secret/rotate',{confirm:'rotate'});setSecret(r.secret);setRotate(false);window.setTimeout(()=>setSecret(''),60000);toast('Signing key rotated. Update the connected senders.');}catch(e){toast(errMsg(e));}finally{setSecretBusy(false);}}}>Rotate signing key</button></>}><p className="modal-explanation">Existing sender signatures will stop being accepted. Update each connected intake sender with the new key before resuming deliveries.</p></Modal>}
  </div></div>;
}
