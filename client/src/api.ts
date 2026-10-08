import type { FeedRequest, FeedResponse, HealthResponse, LoginMode, ReportRequest, ResolveRequest, ResolveResponse, ServerProbe, SessionStatus } from '../../shared/types';

/**
 * API base URL. Empty = same origin (dev server proxy or SERVE_CLIENT deployments). When the
 * client is hosted statically (GitHub Pages) the resolver/proxy lives elsewhere: set it with
 * ?api=https://host, via localStorage, or at build time with VITE_API_BASE.
 */
const STORAGE_KEY = 'streamanywhere.apiBase';
const stripSlash = (v: string): string => v.trim().replace(/\/+$/, '');
function initialApiBase(): string {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q !== null) {
      const v = stripSlash(q);
      localStorage.setItem(STORAGE_KEY, v);
      return v;
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    /* storage unavailable */
  }
  return stripSlash((import.meta.env.VITE_API_BASE as string | undefined) || '');
}
let apiBase = initialApiBase();

export function getApiBase(): string {
  return apiBase;
}
export function setApiBase(v: string): void {
  apiBase = stripSlash(v);
  try {
    localStorage.setItem(STORAGE_KEY, apiBase);
  } catch {
    /* ignore */
  }
}
/** Turns a server-relative path such as /api/media/abc into an absolute URL when an API base is set. */
export function apiUrl(path: string): string {
  return apiBase && path.startsWith('/') ? apiBase + path : path;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: unknown) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, json);
  }
  return json as T;
}

export const api = {
  health: async (): Promise<HealthResponse> => {
    const res = await fetch(apiUrl('/api/health'), { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new ApiError(`health ${res.status}`, res.status);
    return res.json();
  },
  resolve: (req: ResolveRequest): Promise<ResolveResponse> => post('/api/resolve', req),
  probe: (url: string): Promise<ServerProbe> => post('/api/probe', { url, origin: location.origin }),
  report: (req: ReportRequest): Promise<void> => post('/api/report', req).then(() => undefined, () => undefined),
  feed: (req: FeedRequest): Promise<FeedResponse> => post('/api/feed', req),
  session: async (): Promise<SessionStatus> => {
    const res = await fetch(apiUrl('/api/session'), { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new ApiError(`session ${res.status}`, res.status);
    return res.json();
  },
  sessionLogin: (mode: LoginMode): Promise<SessionStatus> => post('/api/session/login', { mode }),
  sessionLogout: (): Promise<SessionStatus> => post('/api/session/logout', {}),
};
