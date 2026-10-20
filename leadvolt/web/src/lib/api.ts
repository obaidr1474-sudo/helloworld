export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

// Authentication lives in an HttpOnly cookie. Browser storage contains no bearer credentials.
localStorage.removeItem('lv_token');
export function setToken(_token:string|null){localStorage.removeItem('lv_token');}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,credentials:'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(!['GET','HEAD','OPTIONS'].includes(method)?{'X-LeadVolt-CSRF':'1'}:{}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if(res.status===401&&['unauthorized','session_revoked'].includes(json.error)&&!['/me','/auth/login','/auth/register'].includes(path)){setToken(null);window.dispatchEvent(new Event('lv:session-ended'));}
  if(res.status===403&&json.error==='mfa_enrollment_required')window.dispatchEvent(new Event('lv:mfa-required'));
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'error', json.message ?? 'Request failed', json.details);
  return json as T;
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export async function signOut(){await api('POST','/auth/logout',{});setToken(null);location.reload();}
