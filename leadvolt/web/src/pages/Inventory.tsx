import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money, num } from '../lib/format';
import { errMsg, toast, type Me } from '../App';
import { Modal } from './Leads';

const blank = { reference: '', projectName: '', community: '', propertyType: 'Apartment', offeringType: 'ready', beds: '1', areaSqft: '', price: '', handover: '', status: 'available', brochureUrl: '', permitNumber: '' };

export function Inventory({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[]>([]); const [edit, setEdit] = useState<any | null>(null); const [matches, setMatches] = useState<{ p: any; list: any[] } | null>(null);
  const canEdit = ['owner', 'admin', 'manager', 'listing_manager'].includes(me.role);
  const load = () => api<any[]>('GET', '/properties').then(setRows).catch((e) => toast(errMsg(e)));
  useEffect(() => { load(); }, []);
  const open = (p?: any) => setEdit(p ? {id:p.id,version:p.version,reference: p.reference, projectName: p.project_name, community: p.community, propertyType: p.property_type, offeringType: p.offering_type, beds: String(p.beds), areaSqft: p.area_sqft ?? '', price: String(p.price), handover: p.handover ?? '', status: p.status, brochureUrl: p.brochure_url ?? '', permitNumber: p.permit_number ?? '' } : { ...blank });
  const save = async () => {
    try {
      const body = { reference: edit.reference || undefined, projectName: edit.projectName, community: edit.community, propertyType: edit.propertyType, offeringType: edit.offeringType,
        beds: Number(edit.beds), areaSqft: edit.areaSqft ? Number(edit.areaSqft) : undefined, price: Number(edit.price), handover: edit.handover || undefined, status: edit.status,
        brochureUrl: edit.brochureUrl || undefined, permitNumber: edit.permitNumber || undefined };
      await api(edit.id ? 'PUT' : 'POST', edit.id ? `/properties/${edit.id}`:'/properties',body,edit.id?{'If-Match':`"${edit.version}"`}:{});
      toast('Property saved'); setEdit(null); load();
    } catch (e) { toast(errMsg(e)); }
  };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setEdit({ ...edit, [k]: e.target.value });
  return <div className="pad">
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}><span className="muted">{rows.filter((p) => p.status === 'available').length} available of {rows.length} units</span><span style={{ flex: 1 }} />{canEdit && <button className="btn primary" onClick={() => open()}>+ Property</button>}</div>
    {rows.length ? <div className="card"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Ref</th><th>Project</th><th>Community</th><th>Type</th><th className="r">Beds</th><th className="r">Sq ft</th><th className="r">Price</th><th>Offering</th><th>Status</th><th /></tr></thead><tbody>
      {rows.map((p) => <tr key={p.id} className="click" onClick={() => canEdit && open(p)}><td className="mono">{p.reference}</td><td><b>{p.project_name}</b></td><td>{p.community}</td><td>{p.property_type}</td><td className="r">{p.beds === 0 ? 'Studio' : p.beds}</td><td className="r">{num(p.area_sqft)}</td><td className="r mono">{money(p.price)}</td><td>{p.offering_type === 'off_plan' ? `Off-plan ${p.handover ?? ''}` : 'Ready'}</td><td><span className={`pill ${p.status === 'available' ? 'good' : ''}`}>{p.status}</span></td>
        <td><button className="btn sm" onClick={async (e) => { e.stopPropagation(); setMatches({ p, list: await api('GET', `/properties/${p.id}/matching-leads`) }); }}>Matching leads</button></td></tr>)}
    </tbody></table></div></div> : <div className="empty"><h3>No properties yet</h3><p>Add units so LeadVolt can match them to leads.</p></div>}
    {edit && <Modal title={edit.id ? 'Edit property' : 'New property'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="grid2">
        <div className="field"><label>Project</label><input className="in" value={edit.projectName} onChange={set('projectName')} /></div>
        <div className="field"><label>Community</label><input className="in" value={edit.community} onChange={set('community')} /></div>
        <div className="field"><label>Reference</label><input className="in" value={edit.reference} onChange={set('reference')} /></div>
        <div className="field"><label>Type</label><select className="in" value={edit.propertyType} onChange={set('propertyType')}>{['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Plot', 'Office', 'Retail'].map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Offering</label><select className="in" value={edit.offeringType} onChange={set('offeringType')}><option value="ready">Ready</option><option value="off_plan">Off-plan</option></select></div>
        <div className="field"><label>Status</label><select className="in" value={edit.status} onChange={set('status')}>{['available', 'reserved', 'sold', 'rented', 'off_market'].map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field"><label>Bedrooms</label><input className="in" type="number" min={0} value={edit.beds} onChange={set('beds')} /></div>
        <div className="field"><label>Area (sq ft)</label><input className="in" type="number" value={edit.areaSqft} onChange={set('areaSqft')} /></div>
        <div className="field"><label>Price (AED)</label><input className="in" type="number" value={edit.price} onChange={set('price')} /></div>
        <div className="field"><label>Handover</label><input className="in" value={edit.handover} onChange={set('handover')} placeholder="Q4 2027" /></div>
        <div className="field"><label>Permit number</label><input className="in" value={edit.permitNumber} onChange={set('permitNumber')} /></div>
        <div className="field"><label>Brochure URL</label><input className="in" type="url" value={edit.brochureUrl} onChange={set('brochureUrl')} /></div>
      </div></Modal>}
    {matches && <Modal title={`Leads matching ${matches.p.project_name}`} onClose={() => setMatches(null)}>
      {matches.list.length ? matches.list.map((m) => <div key={m.lead.id} className="mini"><span className="t">{m.lead.name} <span className="muted">#{m.lead.serialNo}</span></span><span className="pill acc">{m.score}%</span></div>) : <p className="muted">No active leads match this unit.</p>}
    </Modal>}
  </div>;
}
