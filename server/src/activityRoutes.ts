/**
 * The HTTP side of activity.ts: every API request that can take more than a moment becomes an
 * activity (named from its route and body) until its response is out, and GET /api/activity
 * serves the list with the last log lines and the machine's state.
 *
 * Requests that are polled or answered from memory (health, progress, job status, media bytes,
 * Live TV segments) are not listed; the media relay names its own slow part (proxy.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActivityResponse, Platform, ServerStatus } from '../../shared/types';
import { activitySnapshot, beginActivity, endActivity, inActivity } from './activity';
import { recentLogLines } from './logbuf';

const NAMES: Record<Platform, string> = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };
const platformIn = (v: unknown): Platform | undefined => (v === 'tiktok' || v === 'youtube' || v === 'instagram' || v === 'facebook' ? v : undefined);
const nameOf = (v: unknown): string => NAMES[platformIn(v) || 'tiktok'];
const quote = (v: unknown, max = 40): string => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? t.slice(0, max - 1) + '…' : t}"`;
};

/** The platform a video URL belongs to, and a short form of the URL for the status line. */
function videoOf(raw: unknown): { platform?: Platform; short: string } {
  try {
    const u = new URL(String(raw));
    const h = u.hostname.toLowerCase().replace(/^(www|m|music|vm|vt)\./, '');
    const platform: Platform | undefined = /(^|\.)youtube(-nocookie)?\.com$|^youtu\.be$/.test(h) ? 'youtube' : /(^|\.)tiktok\.com$/.test(h) ? 'tiktok' : /(^|\.)instagram\.com$/.test(h) ? 'instagram' : /(^|\.)(facebook\.com|fb\.watch)$/.test(h) ? 'facebook' : undefined;
    const id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
    return { platform, short: platform ? id.slice(0, 24) : h };
  } catch {
    return { short: '' };
  }
}

interface Described {
  what: string;
  platform?: Platform;
  /** What the request is about, as the page names it too (client/src/api.ts waitRef): a video's address */
  ref?: string;
}

/**
 * What a request is, in words, or undefined for requests that are not listed. `body` and `query`
 * are what the client sent (unchecked: every field is read defensively).
 */
export function describeRequest(method: string, path: string, body: any, query: any): Described | undefined {
  const b = body && typeof body === 'object' ? body : {};
  const q = query && typeof query === 'object' ? query : {};
  const P = (v: unknown): Described['platform'] => platformIn(v) || 'tiktok';
  if (method === 'POST') {
    switch (path) {
      case '/api/resolve': {
        const v = videoOf(b.url);
        return { what: v.platform ? `Getting a ${NAMES[v.platform]} video ready (${v.short})` : `Getting a video ready (${v.short})`, platform: v.platform, ref: b.url ? String(b.url).slice(0, 300) : undefined };
      }
      case '/api/probe':
        return { what: `Testing a video address (${videoOf(b.url).short})` };
      case '/api/feed': {
        const src = b.source === 'foryou' ? 'For You' : b.category !== undefined ? `Explore (${String(b.category).slice(0, 24)})` : 'Explore';
        return { what: `Loading ${nameOf(b.platform)} ${src} videos`, platform: P(b.platform) };
      }
      case '/api/search':
        return { what: `Searching ${nameOf(b.platform)} for ${quote(b.q)}${Number(b.offset) > 0 ? ' (more results)' : ''}`, platform: P(b.platform) };
      case '/api/profile':
        return { what: `Loading the videos of @${String(b.user || '').slice(0, 40)} from ${nameOf(b.platform)}`, platform: P(b.platform) };
      case '/api/follow':
        return { what: `${b.follow === false ? 'Unfollowing' : 'Following'} @${String(b.user || '').slice(0, 40)} on ${nameOf(b.platform)}`, platform: P(b.platform) };
      case '/api/comments':
        return { what: `Reading the comments of a ${nameOf(b.platform)} video`, platform: P(b.platform) };
      case '/api/comments/replies':
        return { what: `Reading the replies to a comment on a ${nameOf(b.platform)} video`, platform: P(b.platform) };
      case '/api/inbox/open':
        return { what: 'Opening a TikTok conversation', platform: 'tiktok' };
      case '/api/inbox/send':
        return { what: 'Sending a TikTok message', platform: 'tiktok' };
      case '/api/inbox/cancel':
      case '/api/comments/cancel':
        return { what: 'Stopping a read that is no longer wanted' };
      case '/api/session/accounts':
        // (switching the test on or off answers at once)
        return b.action === 'switch' ? { what: 'Switching the TikTok account', platform: 'tiktok' } : b.action === 'add' ? { what: 'Adding a TikTok account', platform: 'tiktok' } : b.action === 'remove' ? { what: 'Removing a TikTok account', platform: 'tiktok' } : undefined;
      case '/api/session/login':
        return { what: `Starting the ${nameOf(b.platform)} sign-in`, platform: P(b.platform) };
      case '/api/session/logout':
        return { what: `Signing out of ${nameOf(b.platform)}`, platform: P(b.platform) };
      case '/api/session/cancel':
        return { what: `Cancelling the ${nameOf(b.platform)} sign-in`, platform: P(b.platform) };
      case '/api/session/input':
        return { what: `Passing your input to the ${nameOf(b.platform)} sign-in page`, platform: P(b.platform) };
      case '/api/download/probe':
        return { what: `Downloader: looking at ${videoOf(b.url).short || 'a link'} for its video files` };
      case '/api/download/start':
        return { what: 'Downloader: starting a download' };
      case '/api/library':
        return { what: `Library: saving a video link (${videoOf(b.url).short})` };
      case '/api/library/import':
        return { what: `Library: starting a download to the server (${videoOf(b.url).short})` };
      case '/api/livetv/providers':
        return { what: 'Live TV: adding a provider (reading its channel list)' };
      case '/api/livetv/providers/test':
        return { what: 'Live TV: testing a provider' };
      case '/api/livetv/tune':
        return { what: 'Live TV: opening a channel' };
    }
    if (/^\/api\/library\/entries\/[^/]+\/refresh$/.test(path)) return { what: "Library: refreshing a video's details at its source" };
    if (/^\/api\/library\/entries\/[^/]+\/import$/.test(path)) return { what: 'Library: starting a download to the server' };
    if (/^\/api\/livetv\/providers\/[^/]+\/refresh$/.test(path)) return { what: "Live TV: refreshing a provider's channel list" };
    if (/^\/api\/livetv\/providers\/[^/]+$/.test(path)) return { what: 'Live TV: saving a provider (reading its channel list)' };
    return undefined;
  }
  if (method === 'GET') {
    if (path === '/api/inbox') return { what: 'Reading your TikTok messages', platform: 'tiktok' };
    if (path === '/api/session' && q.recheck) return { what: `Checking the ${nameOf(q.platform)} sign-in`, platform: P(q.platform) };
    if (path === '/api/livetv') return { what: 'Live TV: loading your providers' };
    if (path === '/api/livetv/channels') return { what: 'Live TV: loading the channel list' };
    if (/^\/api\/livetv\/guide\/[^/]+$/.test(path)) return { what: "Live TV: reading a channel's guide" };
    if (/^\/api\/library\/entries\/[^/]+\/options$/.test(path)) return { what: 'Library: looking up the qualities on offer' };
  }
  return undefined;
}

const KEY = Symbol('activity');
type Tracked = FastifyRequest & { [KEY]?: ReturnType<typeof beginActivity> };

export function registerActivity(app: FastifyInstance, serverStatus: () => ServerStatus): void {
  // preHandler: the body is parsed, and the handler runs right after, inside the activity.
  app.addHook('preHandler', (req, reply, done) => {
    let d: Described | undefined;
    const path = req.url.split('?')[0];
    try {
      d = describeRequest(req.method, path, req.body, req.query);
    } catch {
      d = undefined;
    }
    if (!d) return done();
    const act = beginActivity(d.what, { platform: d.platform, route: `${req.method} ${path}`, ref: d.ref });
    (req as Tracked)[KEY] = act;
    // 'close' comes when the response is out and also when the viewer's side hung up first
    reply.raw.once('close', () => endActivity(act, reply.raw.writableEnded ? { failed: reply.statusCode >= 400, result: reply.statusCode >= 400 ? act.result || `HTTP ${reply.statusCode}` : undefined } : { failed: true, result: 'the viewer stopped waiting' }));
    inActivity(act, done);
  });
  // The error text of a failed answer, for "failed: …" in the list.
  app.addHook('onSend', (req, reply, payload, done) => {
    const act = (req as Tracked)[KEY];
    if (act && reply.statusCode >= 400 && typeof payload === 'string' && payload.length < 4000) {
      try {
        const err = (JSON.parse(payload) as { error?: unknown }).error;
        if (typeof err === 'string') act.result = err.slice(0, 240);
      } catch {
        /* not JSON */
      }
    }
    done(null, payload);
  });

  app.get('/api/activity', async (_req, reply): Promise<ActivityResponse> => {
    reply.header('cache-control', 'no-store');
    const now = Date.now();
    return {
      activities: activitySnapshot(),
      recent: recentLogLines().map((l) => ({ agoMs: now - l.at, level: l.level, text: l.text })),
      server: serverStatus(),
    };
  });
}
