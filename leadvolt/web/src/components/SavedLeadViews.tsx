import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {errMsg,toast,type Me} from '../App';
import {Modal} from '../pages/Leads';
import {Icon} from './Icon';
export function SavedLeadViews({me,filters,onApply}:{me:Me;filters:Record<string,unknown>;onApply:(query:any)=>void}){
 const [views,setViews]=useState<any[]>([]),[id,setId]=useState(''),[modal,setModal]=useState<string|null>(null),[name,setName]=useState(''),[shared,setShared]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const manager=['owner','admin','manager'].includes(me.role),canWrite=me.role!=='viewer';
 const active=views.find(v=>v.id===id),canManage=!!active&&(active.owner_id===me.id||(active.is_shared&&manager));
 const load=()=>api<any[]>('GET','/saved-views').then(setViews).catch(e=>toast(errMsg(e)));
 useEffect(()=>{load();},[]);
 const open=(action:string)=>{setModal(action);setName(action==='edit'?active.name:'');setShared(action==='edit'?active.is_shared:false);setError('');};
 const save=async()=>{if(busy)return;setBusy(true);setError('');try{
  if(modal==='delete'){await api('DELETE','/saved-views/'+active.id,undefined,{'If-Match':`"${active.version}"`});setId('');toast('Saved view removed');}
  else{const v=await api(modal==='edit'?'PUT':'POST',modal==='edit'?'/saved-views/'+active.id:'/saved-views',{name,query:filters,isShared:shared},modal==='edit'?{'If-Match':`"${active.version}"`}:{});setId(v.id);toast('Lead view saved');}
  await load();setModal(null);
 }catch(e){setError(errMsg(e));}finally{setBusy(false);}};
 return <div className="saved-views-bar"><Icon name="columns" size={16}/><label>Saved view<select aria-label="Saved lead view" className="in" value={id} onChange={e=>{setId(e.target.value);const view=views.find(v=>v.id===e.target.value);if(view)onApply(view.query);}}><option value="">Current filters</option>{views.map(v=><option key={v.id} value={v.id}>{v.name}{v.is_shared?' · Shared':''}</option>)}</select></label>{canWrite&&<button className="btn sm" onClick={()=>open('new')}>Save current view</button>}{canManage&&canWrite&&<><button className="btn sm" onClick={()=>open('edit')}>Update saved view</button><button className="text-button" onClick={()=>open('delete')}>Remove view</button></>}{active&&<small>{active.is_shared?'Shared by '+active.owner_name:'Your personal view'} · Current access permissions always apply.</small>}
 {modal&&<Modal title={modal==='delete'?'Remove saved view':modal==='edit'?'Update saved lead view':'Save lead view'} onClose={()=>setModal(null)} footer={<><button className="btn" disabled={busy} onClick={()=>setModal(null)}>Cancel</button><button className="btn primary" disabled={busy||(modal!=='delete'&&!name.trim())} onClick={save}>{busy?'Saving…':modal==='delete'?'Remove saved view':'Save view'}</button></>}>
 {modal==='delete'?<p>Remove “{active.name}” from the saved views list? Your leads and current filters stay in place.</p>:<><label className="field">View name<input className="in" aria-label="Saved view name" value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></label>{manager&&<label className="switch"><input type="checkbox" checked={shared} onChange={e=>setShared(e.target.checked)}/>Share with the workspace</label>}<p className="modal-explanation">Saves your current scope, queue, search, source, owner, status, temperature, dates and sorting. A shared view never gives an agent access to another agent’s leads.</p></>}
 {error&&<p role="alert" className="err">{error}</p>}
 </Modal>}
 </div>;
}
