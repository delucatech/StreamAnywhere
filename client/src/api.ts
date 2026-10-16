import type { ConversationResponse, DownloadJob, DownloadProbeResponse, DownloadSource, FeedProgress, LibraryCategory, LibraryEntry, LibraryEntryPatch, LibraryOptionsResponse, LibrarySaveResponse, LibraryState, FeedRequest, FeedResponse, FollowRequest, FollowResponse, HealthResponse, InboxResponse, LoginMode, Platform, ProfileRequest, ProfileResponse, ReportRequest, ResolveRequest, ResolveResponse, SearchRequest, SearchResponse, SendMessageRequest, SendMessageResponse, ServerProbe, SessionInputRequest, SessionStatus } from '../../shared/types';

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

/** 401 = the site password cookie is missing or expired: back to the server's login page. */
/** The site password cookie is gone: the server's own 401 names its login page. A platform's "not signed in" 401 does not. */
function toLoginOn401(res: Response, body?: unknown): void {
  const login = (body as { login?: unknown } | undefined)?.login;
  if (res.status === 401 && !apiBase && (body === undefined || typeof login === 'string')) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
}

/** `timeoutMs`: give up (ApiError 504) when the answer takes longer, the body included. */
async function post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const ctl = timeoutMs ? new AbortController() : undefined;
  const timer = ctl ? window.setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  let res: Response;
  let text: string;
  try {
    res = await fetch(apiUrl(path), { method: 'POST', mode: 'cors', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl?.signal });
    text = await res.text();
  } catch (e) {
    if (ctl?.signal.aborted) throw new ApiError(`no answer from the server in ${Math.round(timeoutMs! / 1000)} s`, 504);
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  toLoginOn401(res, json ?? null);
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, json);
  }
  return json as T;
}

export const api = {
  health: async (): Promise<HealthResponse> => {
    const res = await fetch(apiUrl('/api/health'), { mode: 'cors', credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(`health ${res.status}`, res.status);
    return res.json();
  },
  resolve: (req: ResolveRequest, timeoutMs?: number): Promise<ResolveResponse> => post('/api/resolve', req, timeoutMs),
  probe: (url: string): Promise<ServerProbe> => post('/api/probe', { url, origin: location.origin }),
  report: (req: ReportRequest): Promise<void> => post('/api/report', req).then(() => undefined, () => undefined),
  feed: (req: FeedRequest): Promise<FeedResponse> => post('/api/feed', req),
  /** The step a slow feed fill is on (shown on the loading screen); no text when nothing runs or on any failure. */
  feedProgress: async (platform: Platform): Promise<FeedProgress> => {
    try {
      const res = await fetch(apiUrl(`/api/feed/progress?platform=${platform}`), { mode: 'cors', credentials: 'same-origin', cache: 'no-store' });
      return res.ok ? await res.json() : { platform };
    } catch {
      return { platform };
    }
  },
  session: async (platform: Platform = 'tiktok', recheck = false): Promise<SessionStatus> => {
    const res = await fetch(apiUrl(`/api/session?platform=${platform}${recheck ? '&recheck=1' : ''}`), { mode: 'cors', credentials: 'same-origin' });
    toLoginOn401(res);
    if (!res.ok) throw new ApiError(`session ${res.status}`, res.status);
    return res.json();
  },
  sessionLogin: (mode: LoginMode, platform: Platform = 'tiktok', cookies?: string): Promise<SessionStatus> => post('/api/session/login', { mode, platform, cookies }),
  sessionLogout: (platform: Platform = 'tiktok'): Promise<SessionStatus> => post('/api/session/logout', { platform }),
  sessionCancel: (platform: Platform = 'tiktok'): Promise<SessionStatus> => post('/api/session/cancel', { platform }),
  sessionInput: (req: SessionInputRequest): Promise<SessionStatus> => post('/api/session/input', req),
  search: (req: SearchRequest): Promise<SearchResponse> => post('/api/search', req),
  profile: (req: ProfileRequest): Promise<ProfileResponse> => post('/api/profile', req),
  follow: (req: FollowRequest): Promise<FollowResponse> => post('/api/follow', req),
  inbox: async (): Promise<InboxResponse> => {
    const res = await fetch(apiUrl('/api/inbox'), { mode: 'cors', credentials: 'same-origin' });
    toLoginOn401(res);
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError((json as { error?: string })?.error || `inbox ${res.status}`, res.status, json);
    return json as InboxResponse;
  },
  // Video Downloader (download.html)
  downloadSources: async (): Promise<{ sources: { id: DownloadSource; name: string; enabled: boolean }[]; maxBytes: number; ffmpeg: boolean; ytdlp: boolean }> => {
    const res = await fetch(apiUrl('/api/download/sources'), { mode: 'cors', credentials: 'same-origin' });
    toLoginOn401(res);
    if (!res.ok) throw new ApiError(`sources ${res.status}`, res.status);
    return res.json();
  },
  downloadProbe: (url: string): Promise<DownloadProbeResponse> => post('/api/download/probe', { url }, 60_000),
  downloadStart: (probeId: string, optionId: string): Promise<DownloadJob> => post('/api/download/start', { probeId, optionId }, 30_000),
  downloadJob: async (jobId: string): Promise<DownloadJob> => {
    const res = await fetch(apiUrl(`/api/download/jobs/${jobId}`), { mode: 'cors', credentials: 'same-origin', cache: 'no-store' });
    toLoginOn401(res);
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError((json as { error?: string })?.error || `job ${res.status}`, res.status, json);
    return json as DownloadJob;
  },
  downloadCancel: (jobId: string): Promise<DownloadJob> => post(`/api/download/jobs/${jobId}/cancel`, {}),
  inboxOpen: (id: string): Promise<ConversationResponse> => post('/api/inbox/open', { id }),
  inboxSend: (req: SendMessageRequest): Promise<SendMessageResponse> => post('/api/inbox/send', req),
  // Video Library (library.html)
  /** The whole library, or { rev, unchanged: true } when nothing changed since `rev` */
  library: async (rev?: number): Promise<LibraryState | { rev: number; unchanged: true }> => {
    const res = await fetch(apiUrl(`/api/library${rev !== undefined ? `?rev=${rev}` : ''}`), { mode: 'cors', credentials: 'same-origin', cache: 'no-store' });
    toLoginOn401(res);
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError((json as { error?: string })?.error || `library ${res.status}`, res.status, json);
    return json as LibraryState;
  },
  librarySave: (url: string, categoryIds?: string[]): Promise<LibrarySaveResponse> => post('/api/library', { url, categoryIds }, 30_000),
  libraryPatch: (id: string, patch: LibraryEntryPatch): Promise<{ entry: LibraryEntry; state: LibraryState }> => post(`/api/library/entries/${id}`, patch),
  libraryDelete: (id: string): Promise<LibraryState> => post(`/api/library/entries/${id}/delete`, {}),
  libraryRefresh: (id: string): Promise<{ entry: LibraryEntry; state: LibraryState }> => post(`/api/library/entries/${id}/refresh`, {}),
  /** The qualities on offer right now (a lookup at the source: a few seconds, longer on a cold server) */
  libraryOptions: async (id: string, timeoutMs = 120_000): Promise<LibraryOptionsResponse> => {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/library/entries/${id}/options`), { mode: 'cors', credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) throw new ApiError(`no answer from the server in ${Math.round(timeoutMs / 1000)} s`, 504);
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
    toLoginOn401(res);
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError((json as { error?: string })?.error || `options ${res.status}`, res.status, json);
    return json as LibraryOptionsResponse;
  },
  libraryAddCategory: (name: string): Promise<{ category: LibraryCategory; state: LibraryState }> => post('/api/library/categories', { name }),
  libraryRenameCategory: (id: string, name: string): Promise<{ category: LibraryCategory; state: LibraryState }> => post(`/api/library/categories/${id}`, { name }),
  libraryDeleteCategory: (id: string): Promise<LibraryState> => post(`/api/library/categories/${id}/delete`, {}),
};
