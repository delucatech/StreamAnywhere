/**
 * Xtream Codes panels: the de-facto IPTV provider API. Everything is one GET on player_api.php
 * with the account in the query (the panel knows no other way), live streams are served from
 * /live/<user>/<password>/<stream id>.m3u8 (HLS) or .ts (raw MPEG-TS), and the panel's guide is
 * xmltv.php. The account is only ever put in URLs here; the log sees them redacted.
 */
import type { LiveTvAccount } from '../../shared/types';
import { fetchLiveText, redactUrl } from './livetvHttp';
import type { M3uChannel } from './livetvM3u';

export interface XtreamCreds {
  server: string;
  username: string;
  password: string;
}

export class XtreamError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
  }
}

/** "panel.example:8080/player_api.php?…" -> "http://panel.example:8080" */
export function normalizeXtreamServer(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) throw new XtreamError('Enter the server URL (as the provider gave it, e.g. http://host:8080)', 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new XtreamError('That server URL is not valid', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new XtreamError('The server URL must start with http:// or https://', 400);
  // the path the provider pasted (player_api.php, get.php, a playlist link) is not part of the panel address
  let base = u.pathname.replace(/\/(player_api\.php|get\.php|xmltv\.php|panel_api\.php|c\/?|live\/.*|movie\/.*|series\/.*)$/i, '').replace(/\/+$/, '');
  if (/\.(php|m3u8?)$/i.test(base)) base = '';
  return `${u.protocol}//${u.host}${base}`;
}

const q = (c: XtreamCreds, extra = ''): string => `username=${encodeURIComponent(c.username)}&password=${encodeURIComponent(c.password)}${extra}`;

export const xtreamApiUrl = (c: XtreamCreds, action?: string): string => `${c.server}/player_api.php?${q(c, action ? `&action=${action}` : '')}`;
export const xtreamEpgUrl = (c: XtreamCreds): string => `${c.server}/xmltv.php?${q(c)}`;
export const xtreamLiveUrl = (c: XtreamCreds, streamId: string | number, ext: 'm3u8' | 'ts'): string => `${c.server}/live/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${streamId}.${ext}`;
export const xtreamSecrets = (c: XtreamCreds): string[] => [c.password, c.username];

async function api<T>(c: XtreamCreds, action: string | undefined, log: (m: string) => void): Promise<T> {
  const url = xtreamApiUrl(c, action);
  const t0 = Date.now();
  let r;
  try {
    r = await fetchLiveText(url, { limit: 48 * 1024 * 1024, timeoutMs: 30_000 });
  } catch (e) {
    throw new XtreamError(`The panel did not answer (${(e as Error).message})`, 502);
  }
  let json: unknown;
  try {
    json = JSON.parse(r.text);
  } catch {
    const head = r.text.trim().slice(0, 80);
    throw new XtreamError(/<html|<!doctype/i.test(head) ? 'The server URL answers with a web page, not the Xtream API: check the address (host and port)' : `The panel's answer is not JSON (${head || 'empty'})`, 502);
  }
  log(`xtream ${action || 'account'} from ${redactUrl(url, xtreamSecrets(c))}: ${r.text.length} bytes, ${Date.now() - t0} ms`);
  return json as T;
}

interface UserInfoAnswer {
  user_info?: { auth?: number | string; status?: string; exp_date?: string | number | null; max_connections?: string | number; active_cons?: string | number; message?: string };
  server_info?: { url?: string; port?: string; https_port?: string; server_protocol?: string; timezone?: string };
}

export async function xtreamAccount(c: XtreamCreds, log: (m: string) => void): Promise<{ account: LiveTvAccount; message: string }> {
  const a = await api<UserInfoAnswer>(c, undefined, log);
  const ui = a.user_info || {};
  const authed = String(ui.auth) === '1' || ui.auth === 1;
  const exp = Number(ui.exp_date);
  const account: LiveTvAccount = {
    status: ui.status,
    expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined,
    maxConnections: Number(ui.max_connections) || undefined,
    activeConnections: ui.active_cons !== undefined ? Number(ui.active_cons) : undefined,
  };
  if (!authed) throw new XtreamError(ui.message ? `The panel refused the account: ${ui.message}` : 'The panel refused the account (wrong username or password?)', 401);
  if (ui.status && !/^active$/i.test(ui.status)) throw new XtreamError(`The account is ${ui.status.toLowerCase()} on the panel`, 403);
  const parts = [`account ${ui.status || 'ok'}`];
  if (account.expiresAt) parts.push(`expires ${new Date(account.expiresAt).toLocaleDateString('en-GB')}`);
  if (account.maxConnections) parts.push(`${account.maxConnections} connection${account.maxConnections === 1 ? '' : 's'}`);
  return { account, message: parts.join(', ') };
}

interface XtreamCategory {
  category_id?: string | number;
  category_name?: string;
}
interface XtreamStream {
  num?: number | string;
  name?: string;
  stream_id?: number | string;
  stream_icon?: string;
  epg_channel_id?: string | null;
  category_id?: string | number | null;
  category_ids?: (string | number)[];
  stream_type?: string;
}

/** The panel's live channels as playlist channels (the stream URL is the HLS one; the .ts one is the fallback at play time). */
export async function xtreamLiveChannels(c: XtreamCreds, log: (m: string) => void): Promise<M3uChannel[]> {
  const [cats, streams] = await Promise.all([api<XtreamCategory[]>(c, 'get_live_categories', log), api<XtreamStream[]>(c, 'get_live_streams', log)]);
  const catName = new Map<string, string>();
  if (Array.isArray(cats)) for (const cat of cats) if (cat && cat.category_id !== undefined) catName.set(String(cat.category_id), String(cat.category_name || '').trim());
  if (!Array.isArray(streams)) throw new XtreamError('The panel returned no channel list', 502);
  const out: M3uChannel[] = [];
  for (const s of streams) {
    if (!s || s.stream_id === undefined || s.stream_id === null) continue;
    if (s.stream_type && !/^live$/i.test(String(s.stream_type))) continue;
    const id = String(s.stream_id);
    const catId = s.category_id !== undefined && s.category_id !== null ? String(s.category_id) : s.category_ids?.length ? String(s.category_ids[0]) : '';
    const num = Number(s.num);
    out.push({
      id,
      name: String(s.name || `Channel ${id}`).trim(),
      group: catName.get(catId) || '',
      logo: s.stream_icon ? String(s.stream_icon) : undefined,
      epgId: s.epg_channel_id ? String(s.epg_channel_id) : undefined,
      number: Number.isFinite(num) && num > 0 ? num : undefined,
      url: xtreamLiveUrl(c, id, 'm3u8'),
    });
  }
  return out;
}
