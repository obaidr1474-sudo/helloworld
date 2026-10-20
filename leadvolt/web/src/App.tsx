import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, getToken, setToken } from './lib/api';
import { connectRealtime, onEvent } from './lib/realtime';
import { Dashboard } from './pages/Dashboard';
import { Leads } from './pages/Leads';
import { Tasks } from './pages/Tasks';
import { Inventory } from './pages/Inventory';
import { Inbox } from './pages/Inbox';
import { Team } from './pages/Team';
import { Brand, Icon } from './components/Icon';
import type { LeadRequest } from './pages/Leads';

export interface Me { id: string; email: string; full_name: string; role: string; tenant_name: string; slug: string; is_clocked_in: boolean }
export interface User { id: string; full_name: string; role: string; is_active: boolean; is_clocked_in: boolean; open_leads: number; capacity_max_open_leads: number | null; email: string }

type View = 'dashboard' | 'leads' | 'inbox' | 'tasks' | 'inventory' | 'team';
const NAV: [View, string][] = [['dashboard', 'Dashboard'], ['leads', 'Leads'], ['inbox', 'Inbox'], ['tasks', 'Follow-ups'], ['inventory', 'Properties'], ['team', 'Team & rules']];

let toastFn: (m: string) => void = () => {};
export const toast = (m: string) => toastFn(m);
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const [view, setView] = useState<View>(() => {
    const v = location.hash.split('/')[1] || localStorage.getItem('lv_view');
    return NAV.some(([key]) => key === v) ? v as View : 'dashboard';
  });
  const [search, setSearch] = useState('');
  const [leadRequest, setLeadRequest] = useState<LeadRequest | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [msg, setMsg] = useState('');
  const [openLeadId, setOpenLeadId] = useState<string | null>(() => location.hash.split('/')[1] === 'leads' ? location.hash.split('/')[2] || null : null);
  toastFn = (m) => { setMsg(m); window.setTimeout(() => setMsg(''), 2800); };

  useEffect(() => {
    if (!getToken()) return;
    api<Me>('GET', '/me').then(setMe).catch(() => setToken(null)).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!me) return;
    connectRealtime();
    const load = () => api<User[]>('GET', '/users').then(setUsers).catch(() => {});
    load();
    return onEvent((e) => {
      if (e.type === 'attendance.changed') load();
      if (e.type === 'lead.assigned' && e.data.owner_id === me.id) toast('A lead was assigned to you');
      if (e.type === 'sla.breached' && e.data.owner_id === me.id) toast(`First-response SLA missed: ${e.data.name}`);
      if (e.type === 'share_link.opened' && e.data.owner_id === me.id) toast(`${e.data.lead_name} opened the properties you shared`);
      if (e.type === 'task.due_soon' && e.data.owner_id === me.id) toast(`Due soon: ${e.data.title}`);
    });
  }, [me]);
  useEffect(() => { localStorage.setItem('lv_view', view); }, [view]);
  useEffect(() => {
    const route = () => {
      const [, v, id] = location.hash.split('/');
      if (NAV.some(([key]) => key === v)) { setView(v as View); setOpenLeadId(v === 'leads' ? id || null : null); }
    };
    const shortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('global-search')?.focus(); }
    };
    window.addEventListener('hashchange', route); window.addEventListener('keydown', shortcut);
    return () => { window.removeEventListener('hashchange', route); window.removeEventListener('keydown', shortcut); };
  }, []);

  if (loading) return <div className="empty"><h3>Loading LeadVolt…</h3></div>;
  if (!me) return <Auth onDone={() => location.reload()} />;

  const go = (v: View) => { setView(v); location.hash = `/${v}`; };
  const openLead = (id: string) => { setOpenLeadId(id); setView('leads'); location.hash = `/leads/${id}`; };
  const browseLeads = (filters: LeadRequest['filters'] = {}, create = false) => {
    setLeadRequest({ filters, create, key: Date.now() }); setOpenLeadId(null); go('leads');
  };
  const pages: Record<View, ReactNode> = {
    dashboard: <Dashboard me={me} users={users} openLead={openLead} browseLeads={browseLeads} />,
    leads: <Leads me={me} users={users} initialLeadId={openLeadId} request={leadRequest} onRequestHandled={() => setLeadRequest(null)} onSelect={(id) => { history.replaceState(null, '', `#/leads${id ? '/' + id : ''}`); }} />,
    inbox: <Inbox me={me} openLead={openLead} />,
    tasks: <Tasks me={me} users={users} openLead={openLead} />,
    inventory: <Inventory me={me} />,
    team: <Team me={me} users={users} reload={() => api<User[]>('GET', '/users').then(setUsers)} />,
  };
  const clock = async () => {
    try { await api('POST', me.is_clocked_in ? '/attendance/clock-out' : '/attendance/clock-in', {}); setMe({ ...me, is_clocked_in: !me.is_clocked_in }); }
    catch (e) { toast(errMsg(e)); }
  };
  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <Brand />
        <div className="workspace-label"><span className="workspace-avatar">{me.tenant_name[0]}</span><div><b>{me.tenant_name}</b><small>Real estate workspace</small></div></div>
        <div className="nav-section">WORKSPACE</div>
        {NAV.map(([k, l], i) => <div key={k}>{i === 4 && <div className="nav-section">MANAGEMENT</div>}<button className="nav" aria-current={view === k ? 'page' : undefined} onClick={() => go(k)} title={l}><Icon name={k}/><span>{l}</span>{view === k && <span className="nav-marker"/>}</button></div>)}
        <div className="spacer" />
        <div className="shift-card"><span className={`status-dot ${me.is_clocked_in ? '' : 'local'}`}><i/>{me.is_clocked_in ? "You're on shift" : "You're off shift"}</span><p>{me.is_clocked_in ? 'Ready for your next opportunity.' : 'Clock in to start your day.'}</p><button className="btn" onClick={clock}><Icon name="clock" size={15}/>{me.is_clocked_in ? 'Clock out' : 'Clock in'}</button></div>
        <div className="user-profile"><span className="avatar">{me.full_name.split(' ').map(n => n[0]).slice(0,2).join('')}</span><div><b>{me.full_name}</b><small>{me.role}</small></div><button className="icon-btn" title="Sign out" aria-label="Sign out" onClick={() => { setToken(null); location.reload(); }}><Icon name="logout" size={17}/></button></div>
      </nav>
      <section className="main">
        <header className="top"><div className="breadcrumb">Workspace <Icon name="chevron" size={13}/><strong>{NAV.find((n) => n[0] === view)?.[1]}</strong></div><div className="grow"/>
          <form className="global-search" onSubmit={e => { e.preventDefault(); browseLeads({ q: search, queue: 'all' }); setSearch(''); }}><Icon name="search" size={17}/><input id="global-search" aria-label="Search all leads" placeholder="Search leads…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></form>
          <button className="btn primary" aria-label="New lead" onClick={() => browseLeads({}, true)}><Icon name="plus" size={16}/><span>New lead</span></button>
          <button className="icon-btn" title="Open inbox" aria-label="Open inbox" onClick={() => go('inbox')}><Icon name="inbox"/></button>
          <details className="profile-menu"><summary aria-label="Your profile"><span className="avatar">{me.full_name.split(' ').map(n => n[0]).slice(0,2).join('')}</span></summary><div><b>{me.full_name}</b><small>{me.email}</small><button onClick={clock}><Icon name="clock" size={15}/>{me.is_clocked_in ? 'Clock out' : 'Clock in'}</button><button onClick={() => { setToken(null); location.reload(); }}><Icon name="logout" size={15}/>Sign out</button></div></details>
        </header>
        <div className="content">{pages[view]}</div>
      </section>
      {msg && <div className="toast" role="status">{msg}</div>}
    </div>
  );
}

function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ workspace: '', email: '', password: '', company: '', name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = mode === 'login'
        ? await api<{ token: string }>('POST', '/auth/login', { workspace: f.workspace, email: f.email, password: f.password })
        : await api<{ token: string }>('POST', '/auth/register', { company: f.company, slug: f.workspace, name: f.name, email: f.email, password: f.password });
      setToken(r.token); onDone();
    } catch (e2) { setErr(errMsg(e2)); } finally { setBusy(false); }
  };
  return (
    <div className="auth"><section className="auth-story"><Brand/><div className="auth-story-content"><span className="eyebrow">YOUR NEXT CHAPTER IN REAL ESTATE</span><h2>Every lead.<br/>A new possibility.</h2><p>Bring your people, properties, and conversations together. Make time for the relationships that close deals.</p><div className="auth-proof"><Icon name="leads"/><span>One connected workspace for your entire team.</span></div><div className="auth-proof"><Icon name="shield"/><span>Your workspace. Your data. Your opportunities.</span></div></div><small>LeadVolt · Real estate, with momentum.</small></section><div className="auth-form-wrap"><form onSubmit={submit}><span className="eyebrow">LET’S GET TO WORK</span>
      <h1>{mode === 'login' ? 'Sign in to LeadVolt' : 'Create your workspace'}</h1>
      {mode === 'register' && <>
        <div className="field"><label htmlFor="company">Company</label><input id="company" className="in" required value={f.company} onChange={set('company')} /></div>
        <div className="field"><label htmlFor="name">Your name</label><input id="name" className="in" required value={f.name} onChange={set('name')} /></div></>}
      <div className="field"><label htmlFor="ws">Workspace</label><input id="ws" className="in" required placeholder="e.g. demo" value={f.workspace} onChange={set('workspace')} /></div>
      <div className="field"><label htmlFor="email">Email</label><input id="email" className="in" type="email" required value={f.email} onChange={set('email')} /></div>
      <div className="field"><label htmlFor="pw">Password</label><input id="pw" className="in" type="password" required minLength={mode === 'register' ? 10 : 1} value={f.password} onChange={set('password')} /></div>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create workspace'}</button>
      <button type="button" className="btn ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'New here? Create a workspace' : 'Have an account? Sign in'}</button>
    </form><small className="auth-footnote">A focused workspace for better follow-ups.</small></div></div>
  );
}
