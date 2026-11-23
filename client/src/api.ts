import type { AvatarRequest, AvatarResponse, LiveTvChannelGuideResponse, LiveTvChannelsResponse, LiveTvCodec, LiveTvGuideNowResponse, LiveTvHealthReport, LiveTvPrefs, LiveTvPrefsPatch, LiveTvPreset, LiveTvWindow, LiveTvProvider, LiveTvProviderInput, LiveTvState, LiveTvTestRequest, LiveTvTestResponse, LiveTvTuneResponse, LiveTvTuneStatus, ConversationResponse, DownloadJob, DownloadProbeResponse, DownloadSource, FeedProgress, LibraryCategory, LibraryEntry, LibraryEntryPatch, LibraryOptionsResponse, LibrarySaveHint, LibrarySaveResponse, LibraryState, FeedRequest, FeedResponse, FollowRequest, FollowResponse, HealthResponse, InboxCancelResponse, InboxResponse, CommentsRequest, CommentsResponse, LoginMode, Platform, ProfileRequest, ProfileResponse, ReportRequest, ResolveRequest, ResolveResponse, SearchRequest, SearchResponse, SendMessageRequest, SendMessageResponse, ServerProbe, SessionInputRequest, SessionStatus } from '../../shared/types';
import { beginWait, type WaitName } from './pending';

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

/**
 * What a request is, in the viewer's words, for the status strip (activity.ts shows it with its
 * clock once the answer takes more than a moment); undefined for requests that are polled or
 * answered at once. The server names its side of the same request in activityRoutes.ts.
 */
function waitLabel(method: 'GET' | 'POST', path: string, body?: unknown): string | undefined {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const p = path.split('?')[0];
  const short = (v: unknown, max = 40): string => {
    const t = String(v ?? '').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  if (method === 'POST') {
    switch (p) {
      case '/api/resolve':
        return 'Getting video ready';
      case '/api/probe':
        return 'Testing the address';
      case '/api/feed':
        // the home screen's prefetch / warm-up requests answer at once and are nobody's wait
        return b.prefetch || b.warm ? undefined : 'Loading videos';
      case '/api/search':
        return `Searching for "${short(b.q)}"`;
      case '/api/profile':
        return `Loading the videos of @${short(b.user)}`;
      case '/api/follow':
        return `${b.follow === false ? 'Unfollowing' : 'Following'} @${short(b.user)}`;
      case '/api/comments':
        return 'Loading the comments';
      case '/api/inbox/open':
        return 'Opening the conversation';
      case '/api/inbox/send':
        return 'Sending your message';
      case '/api/session/login':
        return 'Starting the sign-in';
      case '/api/session/logout':
        return 'Signing out';
      case '/api/session/cancel':
        return 'Cancelling the sign-in';
      case '/api/session/input':
        return 'Passing your input to the sign-in page';
      case '/api/download/probe':
        return 'Looking at the link for its video files';
      case '/api/download/start':
        return 'Starting the download';
      case '/api/library':
        return 'Saving to the library';
      case '/api/library/import':
        return 'Starting the download to the library';
      case '/api/livetv/providers':
        return 'Adding the provider (the server reads its channel list)';
      case '/api/livetv/providers/test':
        return 'Testing the provider';
      case '/api/livetv/tune':
        return 'Opening the channel';
    }
    if (/^\/api\/library\/entries\/[^/]+\/refresh$/.test(p)) return "Refreshing the video's details";
    if (/^\/api\/library\/entries\/[^/]+\/import$/.test(p)) return 'Starting the download to the library';
    if (/^\/api\/library\/entries\/[^/]+(\/delete|\/file\/delete)?$/.test(p)) return 'Updating the library';
    if (/^\/api\/livetv\/providers\/[^/]+\/refresh$/.test(p)) return 'Starting a refresh of the channel list';
    if (/^\/api\/livetv\/providers\/[^/]+(\/delete)?$/.test(p)) return 'Saving the provider';
    return undefined;
  }
  if (p === '/api/inbox') return 'Loading your messages';
  if (p === '/api/livetv') return 'Loading Live TV';
  if (p === '/api/livetv/channels') return 'Loading the channel list';
  if (/^\/api\/livetv\/guide\/[^/]+$/.test(p)) return "Loading the channel's guide";
  return undefined;
}

/**
 * The address of a video as both sides name it for the status line: the server's activity for a
 * request carries the same text (activityRoutes.ts), so a wait finds its own lookup among several.
 */
export const waitRef = (url: unknown): string => String(url ?? '').slice(0, 300);

/** A wait with the server's side of it named: the request's route and, for a video lookup, its address. */
function routed(method: 'GET' | 'POST', path: string, body: unknown, name: WaitName | undefined): WaitName | undefined {
  if (!name) return undefined;
  const p = path.split('?')[0];
  const url = p === '/api/resolve' ? (body as { url?: unknown } | undefined)?.url : undefined;
  return { route: `${method} ${p}`, ref: url ? waitRef(url) : undefined, ...(typeof name === 'string' ? { label: name } : name) };
}

/** 401 = the site password cookie is missing or expired: back to the server's login page. */
/** The site password cookie is gone: the server's own 401 names its login page. A platform's "not signed in" 401 does not. */
function toLoginOn401(res: Response, body?: unknown): void {
  const login = (body as { login?: unknown } | undefined)?.login;
  if (res.status === 401 && !apiBase && (body === undefined || typeof login === 'string')) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
}

/** The caller gave up (ApiError 499): the fetch was aborted through the `signal` it passed. */
export const CANCELLED = 499;
export const isCancelled = (e: unknown): boolean => e instanceof ApiError && e.status === CANCELLED;

/**
 * One AbortController for a request: fires on `timeoutMs` and when the caller's `signal` aborts
 * (AbortSignal.any is too new for the car's browser). Undefined when neither is wanted.
 */
function requestAbort(timeoutMs?: number, signal?: AbortSignal): { ctl: AbortController; timer?: number; done: () => void } | undefined {
  if (!timeoutMs && !signal) return undefined;
  const ctl = new AbortController();
  const timer = timeoutMs ? window.setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  const onAbort = (): void => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    ctl,
    timer,
    done: () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
/** What an aborted fetch means: the caller's cancel (499) or the time limit (504). */
const abortedError = (signal: AbortSignal | undefined, timeoutMs: number | undefined): ApiError =>
  signal?.aborted ? new ApiError('Cancelled', CANCELLED) : new ApiError(`no answer from the server in ${Math.round((timeoutMs || 0) / 1000)} s`, 504);

/**
 * `timeoutMs`: give up (ApiError 504) when the answer takes longer, the body included. `signal`: the caller's cancel (ApiError 499).
 * `label`: the wait in the viewer's words for the status strip, instead of the route's own (see waitLabel).
 */
async function post<T>(path: string, body: unknown, timeoutMs?: number, signal?: AbortSignal, label?: WaitName): Promise<T> {
  const ab = requestAbort(timeoutMs, signal);
  const wait = routed('POST', path, body, label ?? waitLabel('POST', path, body));
  const waited = wait ? beginWait(wait) : undefined;
  let res: Response;
  let text: string;
  try {
    res = await fetch(apiUrl(path), { method: 'POST', mode: 'cors', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ab?.ctl.signal });
    text = await res.text();
  } catch (e) {
    if (ab?.ctl.signal.aborted) throw abortedError(signal, timeoutMs);
    throw e;
  } finally {
    ab?.done();
    waited?.();
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

/** GET JSON (same conventions as post: the site's 401 goes to the login page, errors carry the server's message). */
async function getJson<T>(path: string, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  const ab = requestAbort(timeoutMs, signal);
  const wait = routed('GET', path, undefined, waitLabel('GET', path));
  const waited = wait ? beginWait(wait) : undefined;
  let res: Response;
  let json: unknown;
  try {
    res = await fetch(apiUrl(path), { mode: 'cors', credentials: 'same-origin', cache: 'no-store', signal: ab?.ctl.signal });
    json = await res.json().catch(() => undefined);
  } catch (e) {
    if (ab?.ctl.signal.aborted) throw abortedError(signal, timeoutMs);
    throw e;
  } finally {
    ab?.done();
    waited?.();
  }
  toLoginOn401(res);
  if (!res.ok) throw new ApiError((json as { error?: string })?.error || `${res.status} ${res.statusText}`, res.status, json);
  return json as T;
}

export const api = {
  /** `timeoutMs`: give up (ApiError 504) when the server takes longer; without it the browser's own limit applies. */
  health: async (timeoutMs?: number): Promise<HealthResponse> => {
    const ctl = timeoutMs ? new AbortController() : undefined;
    const timer = ctl ? window.setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(apiUrl('/api/health'), { mode: 'cors', credentials: 'same-origin', cache: 'no-store', signal: ctl?.signal });
    } catch (e) {
      if (ctl?.signal.aborted) throw new ApiError(`no answer in ${Math.round(timeoutMs! / 1000)} s`, 504);
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
    if (!res.ok) throw new ApiError(`health ${res.status}`, res.status);
    return res.json();
  },
  /** `label`: the wait in the viewer's words for the status strip (default "Getting the video ready") */
  resolve: (req: ResolveRequest, timeoutMs?: number, label?: WaitName): Promise<ResolveResponse> => post('/api/resolve', req, timeoutMs, undefined, label),
  probe: (url: string): Promise<ServerProbe> => post('/api/probe', { url, origin: location.origin }),
  report: (req: ReportRequest): Promise<void> => post('/api/report', req).then(() => undefined, () => undefined),
  feed: (req: FeedRequest, label?: WaitName): Promise<FeedResponse> => post('/api/feed', req, undefined, undefined, label),
  /** The step a slow feed fill is on (shown on the loading screen); no text when nothing runs or on any failure. */
  feedProgress: async (platform: Platform): Promise<FeedProgress> => {
    try {
      const res = await fetch(apiUrl(`/api/feed/progress?platform=${platform}`), { mode: 'cors', credentials: 'same-origin', cache: 'no-store' });
      return res.ok ? await res.json() : { platform };
    } catch {
      return { platform };
    }
  },
  /** `badge`: the home screen's sign-in badge - only what the server knows, no check started for it. */
  session: async (platform: Platform = 'tiktok', recheck = false, badge = false): Promise<SessionStatus> => {
    // a recheck asks the platform (through the server's browser on TikTok): that one can take a while
    const waited = recheck ? beginWait('Checking the sign-in') : undefined;
    try {
      const res = await fetch(apiUrl(`/api/session?platform=${platform}${recheck ? '&recheck=1' : ''}${badge ? '&badge=1' : ''}`), { mode: 'cors', credentials: 'same-origin' });
      toLoginOn401(res);
      if (!res.ok) throw new ApiError(`session ${res.status}`, res.status);
      return await res.json();
    } finally {
      waited?.();
    }
  },
  sessionLogin: (mode: LoginMode, platform: Platform = 'tiktok', cookies?: string): Promise<SessionStatus> => post('/api/session/login', { mode, platform, cookies }),
  sessionLogout: (platform: Platform = 'tiktok'): Promise<SessionStatus> => post('/api/session/logout', { platform }),
  sessionCancel: (platform: Platform = 'tiktok'): Promise<SessionStatus> => post('/api/session/cancel', { platform }),
  sessionInput: (req: SessionInputRequest): Promise<SessionStatus> => post('/api/session/input', req),
  search: (req: SearchRequest): Promise<SearchResponse> => post('/api/search', req),
  profile: (req: ProfileRequest): Promise<ProfileResponse> => post('/api/profile', req),
  follow: (req: FollowRequest): Promise<FollowResponse> => post('/api/follow', req),
  /** The profile picture of a video's channel (YouTube); answers within a few seconds, without one when there is none */
  avatar: (req: AvatarRequest): Promise<AvatarResponse> => post('/api/avatar', req, 10_000),
  /** The conversation list; `signal` cancels the read (ApiError 499). Pair it with inboxCancel so the server's work stops as well. */
  inbox: (signal?: AbortSignal): Promise<InboxResponse> => getJson('/api/inbox', undefined, signal),
  /** Stops the server's messages reads in flight (the headless page's work), so the next request is not queued behind them. */
  inboxCancel: (): Promise<InboxCancelResponse> => post('/api/inbox/cancel', {}, 10_000),
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
  inboxOpen: (id: string, signal?: AbortSignal): Promise<ConversationResponse> => post('/api/inbox/open', { id }, undefined, signal),
  /** A video's comments (the bubble beside it); `signal` cancels the read (ApiError 499). Pair it with commentsCancel so the server's work stops as well. */
  comments: (req: CommentsRequest, signal?: AbortSignal): Promise<CommentsResponse> => post('/api/comments', req, undefined, signal),
  commentsCancel: (): Promise<InboxCancelResponse> => post('/api/comments/cancel', {}, 10_000),
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
  librarySave: (url: string, categoryIds?: string[], hint?: LibrarySaveHint): Promise<LibrarySaveResponse> => post('/api/library', { url, categoryIds, hint }, 30_000),
  /** "Download to library": the server fetches the video (converted to MP4 when needed) and keeps it for every device */
  libraryImport: (url: string, categoryIds?: string[], hint?: LibrarySaveHint): Promise<LibrarySaveResponse> => post('/api/library/import', { url, categoryIds, hint }, 30_000),
  libraryImportEntry: (id: string): Promise<{ started: boolean; state: LibraryState }> => post(`/api/library/entries/${id}/import`, {}, 30_000),
  /** Stops a running import, or forgets a failed one */
  libraryImportCancel: (id: string): Promise<LibraryState> => post(`/api/library/entries/${id}/import/cancel`, {}),
  libraryDeleteFile: (id: string): Promise<LibraryState> => post(`/api/library/entries/${id}/file/delete`, {}),
  libraryPatch: (id: string, patch: LibraryEntryPatch): Promise<{ entry: LibraryEntry; state: LibraryState }> => post(`/api/library/entries/${id}`, patch),
  libraryDelete: (id: string): Promise<LibraryState> => post(`/api/library/entries/${id}/delete`, {}),
  libraryRefresh: (id: string): Promise<{ entry: LibraryEntry; state: LibraryState }> => post(`/api/library/entries/${id}/refresh`, {}),
  /** The qualities on offer right now (a lookup at the source: a few seconds, longer on a cold server) */
  libraryOptions: async (id: string, timeoutMs = 120_000): Promise<LibraryOptionsResponse> => {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
    const waited = beginWait('Looking up the qualities on offer');
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/library/entries/${id}/options`), { mode: 'cors', credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) throw new ApiError(`no answer from the server in ${Math.round(timeoutMs / 1000)} s`, 504);
      throw e;
    } finally {
      window.clearTimeout(timer);
      waited();
    }
    toLoginOn401(res);
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError((json as { error?: string })?.error || `options ${res.status}`, res.status, json);
    return json as LibraryOptionsResponse;
  },
  libraryAddCategory: (name: string): Promise<{ category: LibraryCategory; state: LibraryState }> => post('/api/library/categories', { name }),
  libraryRenameCategory: (id: string, name: string): Promise<{ category: LibraryCategory; state: LibraryState }> => post(`/api/library/categories/${id}`, { name }),
  libraryDeleteCategory: (id: string): Promise<LibraryState> => post(`/api/library/categories/${id}/delete`, {}),
  // Live TV (livetv.html)
  /** Providers + preferences, or { rev, unchanged: true } when nothing changed since `rev` */
  liveTv: (rev?: number): Promise<LiveTvState | { rev: number; channelsRev: number; unchanged: true }> => getJson(`/api/livetv${rev !== undefined ? `?rev=${rev}` : ''}`, 45_000),
  liveTvChannels: (rev?: number): Promise<LiveTvChannelsResponse | { channelsRev: number; unchanged: true }> => getJson(`/api/livetv/channels${rev !== undefined ? `?rev=${rev}` : ''}`, 90_000),
  liveTvPresets: (): Promise<{ presets: LiveTvPreset[] }> => getJson('/api/livetv/presets'),
  liveTvAddProvider: (input: LiveTvProviderInput): Promise<{ provider: LiveTvProvider; state: LiveTvState }> => post('/api/livetv/providers', input, 30_000),
  liveTvUpdateProvider: (id: string, input: LiveTvProviderInput): Promise<{ provider: LiveTvProvider; state: LiveTvState }> => post(`/api/livetv/providers/${id}`, input, 30_000),
  liveTvDeleteProvider: (id: string): Promise<LiveTvState> => post(`/api/livetv/providers/${id}/delete`, {}),
  liveTvRefreshProvider: (id: string): Promise<LiveTvState> => post(`/api/livetv/providers/${id}/refresh`, {}),
  /** A connection test of a form being filled in, or of a saved provider (its id): up to a minute for a big playlist */
  liveTvTest: (req: LiveTvTestRequest): Promise<LiveTvTestResponse> => post('/api/livetv/providers/test', req, 90_000),
  liveTvTune: (key: string, viewer?: string, maxHeight?: number, codecs?: LiveTvCodec[]): Promise<LiveTvTuneResponse> => post('/api/livetv/tune', { key, viewer, maxHeight, codecs }, 75_000),
  liveTvTuneStatus: (key: string): Promise<LiveTvTuneStatus> => getJson(`/api/livetv/tune/status?key=${encodeURIComponent(key)}`),
  liveTvWindow: (key: string, viewer: string): Promise<LiveTvWindow> => getJson(`/api/livetv/live/${encodeURIComponent(key)}/window?v=${encodeURIComponent(viewer)}`, 10_000),
  liveTvLeave: (key: string, viewer: string): Promise<{ ok: boolean }> => post('/api/livetv/leave', { key, viewer }, 10_000),
  /** How a stream went (the first picture and how long it took, or a failure after it opened): its history on the server */
  liveTvHealth: (report: LiveTvHealthReport): Promise<LiveTvPrefs> => post('/api/livetv/health', report, 10_000),
  liveTvPrefs: (patch: LiveTvPrefsPatch): Promise<LiveTvPrefs> => post('/api/livetv/prefs', patch),
  liveTvGuideNow: (keys: string[]): Promise<LiveTvGuideNowResponse> => getJson(`/api/livetv/guide?keys=${encodeURIComponent(keys.join(','))}`),
  liveTvGuide: (key: string): Promise<LiveTvChannelGuideResponse> => getJson(`/api/livetv/guide/${encodeURIComponent(key)}`),
};
