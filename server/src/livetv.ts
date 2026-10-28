/**
 * Live TV: the providers (M3U playlists, Xtream Codes accounts) every browser of this site
 * shares, their cached channel lists, the viewer's favorites and last channel, and tuning.
 *
 *  - LIVETV_DIR (default next to the library: /var/lib/streamanywhere/livetv on the VM,
 *    ~/.streamanywhere/livetv on a PC) holds providers.json (public fields in the clear, the
 *    credentials as one encrypted blob per provider: livetvCrypto.ts), prefs.json, and one
 *    encrypted channel-list file per provider (stream URLs embed the credentials). The site has
 *    one account (its password): everything here is that account's.
 *  - A refresh fetches the playlist (or the panel's channel list), keeps it, and loads the
 *    provider's programme guide in the background when it names one. Lists older than
 *    STALE_MS are refreshed when the page asks for the state.
 *  - Tuning (livetvStream.ts) opens the channel's stream from here, decides what it is, and the
 *    browser plays the same-origin copy; credentials stay on the server and out of the log.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LiveTvAccount, LiveTvChannel, LiveTvChannelGuideResponse, LiveTvChannelsResponse, LiveTvGuideNowResponse, LiveTvLeaveRequest, LiveTvPrefs, LiveTvPrefsPatch, LiveTvProvider, LiveTvProviderInput, LiveTvProviderKind, LiveTvState, LiveTvTestRequest, LiveTvTestResponse, LiveTvTuneRequest, LiveTvTuneResponse } from '../../shared/types';
import { detectFfmpeg } from './ffmpeg';
import { decryptJson, encryptJson, setLiveTvCryptoLogger } from './livetvCrypto';
import { EPG_TTL_MS, epgLoading, epgStore, forgetEpg, loadEpg, nowNext, programmesFor, setEpgDir, type EpgWanted } from './livetvEpg';
import { checkLiveUrl, fetchLiveText, redactUrl, safeHost } from './livetvHttp';
import { cleanChannelName, countGroups, parseM3u, splitGroups, type M3uChannel } from './livetvM3u';
import { LIVETV_PRESETS, presetById } from './livetvPresets';
import { classify, DVR_WINDOW_SEC, ensureRemux, leaveRemux, pickVariant, registerLiveTvStreamRoutes, remuxAvailable, remuxStats, setLiveTvStreamLogger, setRemuxRoot, shutdownLiveTvStreams, type StreamSource, type Verdict } from './livetvStream';
import { normalizeXtreamServer, xtreamAccount, xtreamEpgUrl, xtreamLiveChannels, xtreamLiveUrl, xtreamSecrets, XtreamError, type XtreamCreds } from './livetvXtream';

export class LiveTvError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

let log: (m: string) => void = () => undefined;
export const setLiveTvLogger = (fn: (m: string) => void): void => {
  log = fn;
  setLiveTvCryptoLogger(fn);
  setLiveTvStreamLogger(fn);
};

// ---------------------------------------------------------------- files

function dataDir(): string {
  if (process.env.LIVETV_DIR) return process.env.LIVETV_DIR;
  const base = process.env.TIKTOK_PROFILE_DIR ? path.dirname(process.env.TIKTOK_PROFILE_DIR) : path.join(os.homedir(), '.streamanywhere');
  return path.join(base, 'livetv');
}
const DIR = dataDir();
const PROVIDERS_FILE = path.join(DIR, 'providers.json');
const PREFS_FILE = path.join(DIR, 'prefs.json');
const CHANNELS_DIR = path.join(DIR, 'channels');
setEpgDir(path.join(DIR, 'epg'));
setRemuxRoot(path.join(DIR, 'cache'));

/** What the provider must keep secret (one encrypted blob) */
interface Secrets {
  url?: string;
  server?: string;
  username?: string;
  password?: string;
}
type Stored = Omit<LiveTvProvider, 'url' | 'server' | 'username' | 'hasPassword'> & { secret: string };
interface ProvidersFile {
  rev: number;
  channelsRev: number;
  providers: Stored[];
}
/** A provider's cached channel list (encrypted on disk) */
interface CachedList {
  at: number;
  channels: M3uChannel[];
  epgUrls: string[];
}

let file: ProvidersFile | undefined;
let prefs: LiveTvPrefs | undefined;
const secretsCache = new Map<string, Secrets>();
const lists = new Map<string, CachedList | null>();
let saveTimer: NodeJS.Timeout | undefined;
let prefsTimer: NodeJS.Timeout | undefined;

const newId = (): string => crypto.randomBytes(6).toString('base64url');

function load(): ProvidersFile {
  if (file) return file;
  try {
    const parsed = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as Partial<ProvidersFile>;
    file = { rev: Number(parsed.rev) || 1, channelsRev: Number(parsed.channelsRev) || 1, providers: Array.isArray(parsed.providers) ? parsed.providers : [] };
    for (const p of file.providers) {
      if (p.refresh?.state === 'running') p.refresh = { ...p.refresh, state: p.refresh.at ? 'ok' : 'never' };
      if (p.epg?.state === 'running') p.epg = { ...p.epg, state: p.epg.at ? 'ok' : 'none' };
    }
  } catch {
    file = { rev: 1, channelsRev: 1, providers: [] };
  }
  return file;
}

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, target);
}

/** Something about the providers changed: rev grows, the file is written soon. */
function changed(channels = false): void {
  const f = load();
  f.rev++;
  if (channels) f.channelsRev++;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      writeJson(PROVIDERS_FILE, f);
    } catch (e) {
      log(`could not save ${PROVIDERS_FILE}: ${(e as Error).message}`);
    }
  }, 150);
  saveTimer.unref?.();
}

function loadPrefs(): LiveTvPrefs {
  if (prefs) return prefs;
  try {
    const parsed = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) as Partial<LiveTvPrefs>;
    const broken: Record<string, number> = {};
    if (parsed.broken && typeof parsed.broken === 'object') for (const [k, v] of Object.entries(parsed.broken)) if (Number(v) > 0) broken[k] = Number(v);
    prefs = {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.map(String) : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.map(String) : [],
      broken,
      lastKey: typeof parsed.lastKey === 'string' ? parsed.lastKey : undefined,
      lastAt: Number(parsed.lastAt) || undefined,
    };
  } catch {
    prefs = { favorites: [], hidden: [], broken: {} };
  }
  return prefs;
}
function prefsChanged(): void {
  load().rev++;
  changed();
  if (prefsTimer) return;
  prefsTimer = setTimeout(() => {
    prefsTimer = undefined;
    try {
      writeJson(PREFS_FILE, loadPrefs());
    } catch (e) {
      log(`could not save ${PREFS_FILE}: ${(e as Error).message}`);
    }
  }, 150);
  prefsTimer.unref?.();
}

export function flushLiveTv(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      writeJson(PROVIDERS_FILE, load());
    } catch {
      /* nothing more to do */
    }
  }
  if (prefsTimer) {
    clearTimeout(prefsTimer);
    prefsTimer = undefined;
    try {
      writeJson(PREFS_FILE, loadPrefs());
    } catch {
      /* nothing more to do */
    }
  }
  shutdownLiveTvStreams();
}

const secretsOf = (p: Stored): Secrets => {
  let s = secretsCache.get(p.id);
  if (!s) {
    s = decryptJson<Secrets>(p.secret) || {};
    secretsCache.set(p.id, s);
  }
  return s;
};
const setSecrets = (p: Stored, s: Secrets): void => {
  p.secret = encryptJson(s);
  secretsCache.set(p.id, s);
};
const credsOf = (p: Stored): XtreamCreds => {
  const s = secretsOf(p);
  return { server: s.server || '', username: s.username || '', password: s.password || '' };
};
const secretStrings = (p: Stored): string[] => (p.kind === 'xtream' ? xtreamSecrets(credsOf(p)) : []);

const listFile = (id: string): string => path.join(CHANNELS_DIR, `${id}.enc`);
function listOf(p: Stored): CachedList | undefined {
  const cached = lists.get(p.id);
  if (cached !== undefined) return cached || undefined;
  let l: CachedList | undefined;
  try {
    l = decryptJson<CachedList>(fs.readFileSync(listFile(p.id), 'utf8'));
    if (l && !Array.isArray(l.channels)) l = undefined;
  } catch {
    l = undefined;
  }
  lists.set(p.id, l || null);
  return l;
}
function saveList(p: Stored, l: CachedList): void {
  lists.set(p.id, l);
  try {
    fs.mkdirSync(CHANNELS_DIR, { recursive: true });
    const tmp = `${listFile(p.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, encryptJson(l), { mode: 0o600 });
    fs.renameSync(tmp, listFile(p.id));
  } catch (e) {
    log(`channel list of ${p.name} not saved: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- public views

function toPublic(p: Stored): LiveTvProvider {
  const { secret, ...rest } = p;
  void secret;
  const s = secretsOf(p);
  const pub: LiveTvProvider = { ...rest };
  if (p.kind === 'm3u') pub.url = s.url;
  else {
    pub.server = s.server;
    pub.username = s.username;
    pub.hasPassword = Boolean(s.password);
  }
  return pub;
}

let remuxFlag: boolean | undefined;
export async function liveTvState(): Promise<LiveTvState> {
  const f = load();
  if (remuxFlag === undefined) remuxFlag = (await detectFfmpeg()).available;
  keepFresh();
  return { rev: f.rev, channelsRev: f.channelsRev, providers: f.providers.map(toPublic), prefs: loadPrefs(), remux: remuxFlag };
}
export const liveTvRev = (): { rev: number; channelsRev: number } => ({ rev: load().rev, channelsRev: load().channelsRev });

const keyOf = (providerId: string, channelId: string): string => `${providerId}:${channelId}`;
const splitKey = (key: string): { providerId: string; channelId: string } | undefined => {
  const i = key.indexOf(':');
  return i > 0 ? { providerId: key.slice(0, i), channelId: key.slice(i + 1) } : undefined;
};

export function liveTvChannels(): LiveTvChannelsResponse {
  const f = load();
  const channels: LiveTvChannel[] = [];
  for (const p of f.providers) {
    if (!p.enabled) continue;
    const l = listOf(p);
    if (!l) continue;
    for (const c of l.channels) {
      const groups = splitGroups(c.group);
      const ch: LiveTvChannel = { key: keyOf(p.id, c.id), providerId: p.id, name: cleanChannelName(c.name) || c.name, group: groups[0] || '', groups };
      if (c.logo) ch.logo = c.logo;
      if (c.epgId) ch.epgId = c.epgId;
      if (c.number) ch.number = c.number;
      if (c.drm) ch.drm = true;
      channels.push(ch);
    }
  }
  return { channelsRev: f.channelsRev, channels };
}

function findChannel(key: string): { p: Stored; c: M3uChannel } | undefined {
  const k = splitKey(key);
  if (!k) return undefined;
  const p = load().providers.find((x) => x.id === k.providerId);
  if (!p) return undefined;
  const c = listOf(p)?.channels.find((x) => x.id === k.channelId);
  return c ? { p, c } : undefined;
}

// ---------------------------------------------------------------- providers: add / edit / delete

const providerOr404 = (id: string): Stored => {
  const p = load().providers.find((x) => x.id === id);
  if (!p) throw new LiveTvError('That provider is no longer there', 404);
  return p;
};

function cleanName(v: unknown, fallback = ''): string {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || fallback;
}

async function cleanM3uUrl(v: unknown): Promise<string> {
  let s = String(v ?? '').trim();
  if (!s) throw new LiveTvError('Enter the playlist URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    await checkLiveUrl(s);
  } catch (e) {
    throw new LiveTvError((e as Error).message);
  }
  return s;
}
async function cleanEpgUrl(v: unknown): Promise<string | undefined> {
  let s = String(v ?? '').trim();
  if (!s) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    await checkLiveUrl(s);
  } catch (e) {
    throw new LiveTvError(`Guide URL: ${(e as Error).message}`);
  }
  return s;
}

const epgSourceOf = (p: Stored, l?: CachedList): LiveTvProvider['epgSource'] => (p.epgUrl ? 'url' : p.kind === 'xtream' ? 'panel' : l && l.epgUrls.length >= 1 && l.epgUrls.length <= 3 ? 'playlist' : 'none');

export async function addProvider(input: LiveTvProviderInput): Promise<LiveTvProvider> {
  const f = load();
  const preset = input.preset ? presetById(input.preset) : undefined;
  const kind: LiveTvProviderKind = preset ? 'm3u' : input.kind === 'xtream' ? 'xtream' : 'm3u';
  const now = Date.now();
  const p: Stored = {
    id: newId(),
    kind,
    name: cleanName(input.name, preset?.name || (kind === 'xtream' ? 'Xtream provider' : 'Playlist')),
    enabled: input.enabled !== false,
    preset: preset?.id,
    epgUrl: await cleanEpgUrl(input.epgUrl ?? preset?.epgUrl),
    epgSource: 'none',
    createdAt: now,
    updatedAt: now,
    refresh: { state: 'never', channels: 0, groups: 0 },
    epg: { state: 'none', channels: 0, programmes: 0 },
    secret: '',
  };
  if (kind === 'm3u') {
    const url = preset ? preset.url : await cleanM3uUrl(input.url);
    if (f.providers.some((x) => x.kind === 'm3u' && secretsOf(x).url === url)) throw new LiveTvError('That playlist is already one of the providers', 409);
    setSecrets(p, { url });
  } else {
    let server: string;
    try {
      server = normalizeXtreamServer(input.server || '');
    } catch (e) {
      throw new LiveTvError((e as Error).message);
    }
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    if (!username || !password) throw new LiveTvError('Enter the username and the password of the account');
    try {
      await checkLiveUrl(server);
    } catch (e) {
      throw new LiveTvError((e as Error).message);
    }
    setSecrets(p, { server, username, password });
  }
  p.epgSource = epgSourceOf(p);
  f.providers.push(p);
  changed();
  log(`provider added: ${p.name} (${p.kind}${p.preset ? ', preset ' + p.preset : ''})`);
  void refreshProvider(p.id).catch(() => undefined);
  return toPublic(p);
}

export async function updateProvider(id: string, input: LiveTvProviderInput): Promise<LiveTvProvider> {
  const p = providerOr404(id);
  let needsRefresh = false;
  if (input.name !== undefined) p.name = cleanName(input.name, p.name);
  if (input.enabled !== undefined) {
    p.enabled = Boolean(input.enabled);
    changed(true);
  }
  if (input.epgUrl !== undefined) {
    const u = await cleanEpgUrl(input.epgUrl);
    if (u !== p.epgUrl) {
      p.epgUrl = u;
      forgetEpg(p.id);
      p.epg = { state: 'none', channels: 0, programmes: 0 };
      needsRefresh = true;
    }
  }
  const s = { ...secretsOf(p) };
  if (p.kind === 'm3u' && input.url !== undefined && !p.preset) {
    const url = await cleanM3uUrl(input.url);
    if (url !== s.url) {
      s.url = url;
      needsRefresh = true;
    }
  }
  if (p.kind === 'xtream') {
    if (input.server !== undefined) {
      let server: string;
      try {
        server = normalizeXtreamServer(input.server);
      } catch (e) {
        throw new LiveTvError((e as Error).message);
      }
      if (server !== s.server) {
        s.server = server;
        needsRefresh = true;
      }
    }
    if (input.username !== undefined && input.username.trim() && input.username.trim() !== s.username) {
      s.username = input.username.trim();
      needsRefresh = true;
    }
    // an empty password in the form means "keep the saved one"
    if (input.password) {
      s.password = input.password;
      needsRefresh = true;
    }
  }
  setSecrets(p, s);
  p.epgSource = epgSourceOf(p, listOf(p));
  p.updatedAt = Date.now();
  changed();
  if (needsRefresh) void refreshProvider(p.id).catch(() => undefined);
  return toPublic(p);
}

export function deleteProvider(id: string): void {
  const f = load();
  const p = providerOr404(id);
  f.providers = f.providers.filter((x) => x.id !== id);
  secretsCache.delete(id);
  lists.delete(id);
  forgetEpg(id);
  try {
    fs.unlinkSync(listFile(id));
  } catch {
    /* none */
  }
  for (const k of [...verdicts.keys()]) if (k.startsWith(id + ':')) verdicts.delete(k);
  const pr = loadPrefs();
  const before = pr.favorites.length + pr.hidden.length + Object.keys(pr.broken).length;
  pr.favorites = pr.favorites.filter((k) => !k.startsWith(id + ':'));
  pr.hidden = pr.hidden.filter((k) => !k.startsWith(id + ':'));
  for (const k of Object.keys(pr.broken)) if (k.startsWith(id + ':')) delete pr.broken[k];
  if (pr.lastKey?.startsWith(id + ':')) pr.lastKey = undefined;
  if (pr.favorites.length + pr.hidden.length + Object.keys(pr.broken).length !== before || !pr.lastKey) prefsChanged();
  changed(true);
  log(`provider deleted: ${p.name}`);
}

// ---------------------------------------------------------------- refresh / test

const STALE_MS = 12 * 60 * 60 * 1000;
const running = new Map<string, Promise<void>>();

/** Fetches the provider's channels (the playlist, or the panel's list). */
async function fetchChannels(p: Stored): Promise<{ channels: M3uChannel[]; epgUrls: string[]; account?: LiveTvAccount; message: string }> {
  const s = secretsOf(p);
  if (p.kind === 'm3u') {
    if (!s.url) throw new LiveTvError('The provider has no playlist URL');
    const r = await fetchLiveText(s.url, { limit: 64 * 1024 * 1024, timeoutMs: 60_000 });
    const head = r.text.trimStart().slice(0, 200);
    if (!head.startsWith('#EXTM3U') && !head.startsWith('#EXTINF')) {
      if (/^<!doctype html|^<html/i.test(head)) throw new LiveTvError('That link answers with a web page, not a playlist');
      if (head.startsWith('{') || head.startsWith('[')) throw new LiveTvError('That link answers with JSON, not an M3U playlist (an Xtream panel? add it as one)');
      throw new LiveTvError(`That link is not an M3U playlist (it starts with "${head.slice(0, 30).replace(/\s+/g, ' ')}")`);
    }
    const pl = parseM3u(r.text);
    if (!pl.channels.length) throw new LiveTvError('The playlist has no channels');
    return { channels: pl.channels, epgUrls: pl.epgUrls, message: `${pl.channels.length} channels${pl.skipped ? `, ${pl.skipped} lines skipped` : ''}` };
  }
  const creds = credsOf(p);
  const acc = await xtreamAccount(creds, log);
  const channels = await xtreamLiveChannels(creds, log);
  return { channels, epgUrls: [], account: acc.account, message: `${acc.message}; ${channels.length} live channels` };
}

export function refreshProvider(id: string): Promise<void> {
  const p = providerOr404(id);
  let job = running.get(id);
  if (job) return job;
  job = (async () => {
    const t0 = Date.now();
    p.refresh = { ...p.refresh, state: 'running', error: undefined };
    changed();
    try {
      const r = await fetchChannels(p);
      const l: CachedList = { at: Date.now(), channels: r.channels, epgUrls: r.epgUrls };
      saveList(p, l);
      const groups = countGroups(r.channels);
      p.refresh = { state: 'ok', at: Date.now(), channels: r.channels.length, groups, ms: Date.now() - t0 };
      if (r.account) p.account = r.account;
      p.epgSource = epgSourceOf(p, l);
      log(`${p.name}: ${r.message}, ${groups} groups, ${Date.now() - t0} ms`);
      changed(true);
      void ensureEpg(p, true).catch(() => undefined);
    } catch (e) {
      const err = e as Error;
      p.refresh = { ...p.refresh, state: 'error', at: Date.now(), error: redactUrl(err.message, secretStrings(p)), ms: Date.now() - t0 };
      log(`${p.name}: refresh failed: ${p.refresh.error}`);
      changed();
    }
  })().finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

/**
 * Enabled providers whose list is old (or missing) are refreshed in the background; one at a
 * time. Runs when the page asks for the state, and on a timer, so the lists (and their guides,
 * loaded after each refresh) are fresh before anyone opens the page.
 */
function keepFresh(): void {
  for (const p of load().providers) {
    if (!p.enabled || running.size) return;
    const l = listOf(p);
    if (p.refresh.state === 'running') continue;
    const at = l?.at || 0;
    if (!l || Date.now() - at > STALE_MS) {
      if (p.refresh.state === 'error' && p.refresh.at && Date.now() - p.refresh.at < 15 * 60_000) continue; // not again right away
      log(`${p.name}: channel list ${l ? 'is stale' : 'missing'}, refreshing`);
      void refreshProvider(p.id).catch(() => undefined);
    }
  }
}
const freshTimer = setInterval(keepFresh, 30 * 60_000);
freshTimer.unref?.();

export async function testProvider(input: LiveTvTestRequest): Promise<LiveTvTestResponse> {
  const t0 = Date.now();
  const saved = input.id ? load().providers.find((x) => x.id === input.id) : undefined;
  const preset = input.preset ? presetById(input.preset) : undefined;
  const kind: LiveTvProviderKind = preset ? 'm3u' : (input.kind || saved?.kind) === 'xtream' ? 'xtream' : 'm3u';
  const secrets = saved ? secretsOf(saved) : {};
  try {
    if (kind === 'm3u') {
      const url = preset ? preset.url : input.url !== undefined && input.url.trim() ? await cleanM3uUrl(input.url) : secrets.url;
      if (!url) throw new LiveTvError('Enter the playlist URL');
      const tmp: Stored = { id: 'test', kind: 'm3u', name: 'test', enabled: true, epgSource: 'none', createdAt: 0, updatedAt: 0, refresh: { state: 'never', channels: 0, groups: 0 }, epg: { state: 'none', channels: 0, programmes: 0 }, secret: '', epgUrl: await cleanEpgUrl(input.epgUrl ?? saved?.epgUrl ?? preset?.epgUrl) };
      secretsCache.set('test', { url });
      const r = await fetchChannels(tmp);
      secretsCache.delete('test');
      const groups = countGroups(r.channels);
      const src = epgSourceOf(tmp, { at: 0, channels: [], epgUrls: r.epgUrls });
      return { ok: true, message: `Playlist OK: ${r.channels.length} channels in ${groups} groups${src === 'none' ? ', no programme guide named' : src === 'playlist' ? ', guide named by the playlist' : ', guide URL set'}`, channels: r.channels.length, groups, epgSource: src, elapsedMs: Date.now() - t0 };
    }
    let server: string;
    try {
      server = normalizeXtreamServer(input.server !== undefined && input.server.trim() ? input.server : secrets.server || '');
    } catch (e) {
      throw new LiveTvError((e as Error).message);
    }
    const username = (input.username && input.username.trim()) || secrets.username || '';
    const password = input.password || secrets.password || '';
    if (!username || !password) throw new LiveTvError('Enter the username and the password');
    await checkLiveUrl(server);
    const creds: XtreamCreds = { server, username, password };
    const acc = await xtreamAccount(creds, log);
    const channels = await xtreamLiveChannels(creds, log);
    const groups = countGroups(channels);
    return { ok: true, message: `Connected: ${acc.message}; ${channels.length} live channels in ${groups} categories; guide from the panel`, channels: channels.length, groups, account: acc.account, epgSource: 'panel', elapsedMs: Date.now() - t0 };
  } catch (e) {
    secretsCache.delete('test');
    const err = e as Error;
    const status = err instanceof LiveTvError || err instanceof XtreamError ? err.status : 502;
    return { ok: false, message: redactUrl(err.message, [input.password || '', secrets.password || '']), elapsedMs: Date.now() - t0, ...(status >= 500 ? {} : {}) };
  }
}

// ---------------------------------------------------------------- the guide

function epgUrlOf(p: Stored): string | undefined {
  if (p.epgUrl) return p.epgUrl;
  if (p.kind === 'xtream') return xtreamEpgUrl(credsOf(p));
  const l = listOf(p);
  return l && l.epgUrls.length >= 1 && l.epgUrls.length <= 3 ? l.epgUrls[0] : undefined;
}

function wantedOf(p: Stored): EpgWanted {
  const l = listOf(p);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const c of l?.channels || []) {
    if (c.epgId) ids.add(c.epgId);
    if (c.name.trim()) names.add(c.name);
  }
  return { ids, names };
}

/** Loads the provider's guide when it has none or it is older than EPG_TTL_MS (in the background unless `force`). */
async function ensureEpg(p: Stored, force = false): Promise<void> {
  const url = epgUrlOf(p);
  if (!url) {
    if (p.epg.state !== 'none') {
      p.epg = { state: 'none', channels: 0, programmes: 0 };
      changed();
    }
    return;
  }
  const store = epgStore(p.id);
  if (!force && store && Date.now() - store.at < EPG_TTL_MS && store.url === url) return;
  if (epgLoading(p.id)) return;
  if (!force && p.epg.state === 'error' && p.epg.at && Date.now() - p.epg.at < 30 * 60_000) return;
  p.epg = { ...p.epg, state: 'running', error: undefined };
  changed();
  try {
    const s = await loadEpg(p.id, url, wantedOf(p), log);
    p.epg = { state: 'ok', at: s.at, channels: s.channels, programmes: s.programmes };
  } catch (e) {
    p.epg = { ...p.epg, state: 'error', at: Date.now(), error: redactUrl((e as Error).message, secretStrings(p)) };
    log(`${p.name}: guide failed: ${p.epg.error}`);
  }
  changed();
}

export function guideNow(keys: string[]): LiveTvGuideNowResponse {
  const out: LiveTvGuideNowResponse = { now: {}, loading: false };
  const now = Date.now();
  for (const key of keys.slice(0, 300)) {
    const found = findChannel(key);
    if (!found) continue;
    const { p, c } = found;
    const store = epgStore(p.id);
    if (!store || now - store.at > EPG_TTL_MS) {
      void ensureEpg(p).catch(() => undefined);
      if (!store) {
        if (epgLoading(p.id)) out.loading = true;
        continue;
      }
    }
    const list = programmesFor(store, c.epgId, c.name);
    if (list) {
      const nn = nowNext(list, now);
      if (nn.now || nn.next) out.now[key] = nn;
    }
  }
  return out;
}

export function guideFor(key: string): LiveTvChannelGuideResponse {
  const found = findChannel(key);
  if (!found) throw new LiveTvError('Unknown channel', 404);
  const { p, c } = found;
  const store = epgStore(p.id);
  if (!store || Date.now() - store.at > EPG_TTL_MS) void ensureEpg(p).catch(() => undefined);
  if (!store) {
    const loading = epgLoading(p.id);
    return { key, programmes: [], loading, note: loading ? 'The guide is loading…' : p.epgSource === 'none' ? 'This provider names no programme guide. A guide URL (XMLTV) can be set on the provider in Settings.' : p.epg.state === 'error' ? `The guide could not be loaded: ${p.epg.error}` : 'No guide yet' };
  }
  const list = programmesFor(store, c.epgId, c.name);
  if (!list) return { key, programmes: [], loading: false, note: `The guide has no listing for this channel${c.epgId ? ` (id ${c.epgId})` : ''}.` };
  const from = Date.now() - 3 * 3600_000;
  return { key, programmes: list.filter((x) => x.stop > from).slice(0, 80), loading: false };
}

// ---------------------------------------------------------------- tuning

const verdicts = new Map<string, Verdict>();
const VERDICT_MS = 5 * 60_000;

function sourceOf(key: string): StreamSource | undefined {
  const found = findChannel(key);
  if (!found) return undefined;
  const { p, c } = found;
  const src: StreamSource = { url: c.url, headers: c.headers, secrets: secretStrings(p) };
  if (p.kind === 'xtream') {
    const k = splitKey(key)!;
    src.alt = xtreamLiveUrl(credsOf(p), k.channelId, 'ts');
  }
  return src;
}

/**
 * Whether the channel's last tune worked is kept with the preferences (every device ranks
 * channels that did not play last time after the others; a tune that works clears it).
 */
function noteTune(key: string, ok: boolean): void {
  const pr = loadPrefs();
  if (ok) {
    if (!(key in pr.broken)) return;
    delete pr.broken[key];
  } else pr.broken[key] = Date.now();
  prefsChanged();
}

/** A viewer id as the page sends it (letters, digits, - and _; at most 64) */
const cleanViewer = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined);

export async function tune(key: string, dvr = true, viewer?: string): Promise<LiveTvTuneResponse> {
  const r = await tuneChannel(key, dvr, viewer);
  noteTune(key, r.state === 'ok');
  return r;
}

async function tuneChannel(key: string, dvr: boolean, viewer: string | undefined): Promise<LiveTvTuneResponse> {
  const t0 = Date.now();
  const found = findChannel(key);
  if (!found) throw new LiveTvError('That channel is not in the list any more (the provider changed its playlist?)', 404);
  const { p, c } = found;
  if (c.drm) return { key, state: 'unsupported', detail: 'DRM', message: 'This channel is DRM-protected (the playlist names license keys); it cannot play here.', elapsedMs: Date.now() - t0 };
  if (!p.enabled) throw new LiveTvError('That provider is disabled', 409);
  const src = sourceOf(key)!;
  const kept = verdicts.get(key);
  let v = kept && Date.now() - kept.at < VERDICT_MS ? kept : undefined;
  let detail: string | undefined;
  let message: string | undefined;
  if (!v) {
    const r = await classify(src);
    if (r.kind === 'unavailable' || r.kind === 'unsupported') {
      verdicts.delete(key);
      log(`tune ${p.name} / ${cleanChannelName(c.name)}: ${r.kind} (${r.detail})`);
      return { key, state: r.kind, detail: r.detail, message: r.message, elapsedMs: Date.now() - t0 };
    }
    v = { kind: r.kind === 'ts' ? 'remux' : r.kind, url: r.url, headers: r.headers, at: Date.now() };
    if (r.kind === 'hls') {
      // what the recorder would read: the variant picked here, checked like any upstream URL
      const input = pickVariant(r.playlist, r.url) || { url: r.url };
      try {
        await checkLiveUrl(input.url);
        v.hlsInput = input;
      } catch (e) {
        log(`tune ${p.name} / ${cleanChannelName(c.name)}: no recorder, variant refused: ${(e as Error).message}`);
      }
    }
    verdicts.set(key, v);
    detail = r.kind === 'progressive' ? r.contentType : r.kind;
  }
  let playUrl: string;
  let recorded = false;
  if (v.kind === 'hls' && dvr && v.hlsInput && (await remuxAvailable())) {
    // pause and rewind: ffmpeg records the variant into a rolling window; the relay stays the fallback
    try {
      playUrl = (await ensureRemux(key, { url: v.hlsInput.url, headers: v.headers, input: 'hls', program: v.hlsInput.program }, src.secrets || [], viewer)).playUrl;
      recorded = true;
      log(`tune ${p.name} / ${cleanChannelName(c.name)}: recorder on ${v.hlsInput.resolution || '?'} ${v.hlsInput.bandwidth ? Math.round(v.hlsInput.bandwidth / 1000) + ' kbps' : ''}, ${Date.now() - t0} ms`);
      return { key, state: 'ok', kind: 'remux', playUrl, detail: `hls, recorded${v.hlsInput.resolution ? ' at ' + v.hlsInput.resolution : ''}`, message, dvr: true, windowSec: DVR_WINDOW_SEC, elapsedMs: Date.now() - t0 };
    } catch (e) {
      log(`tune ${p.name} / ${cleanChannelName(c.name)}: recorder failed (${(e as Error).message}), relaying instead`);
    }
  }
  if (v.kind === 'remux') {
    try {
      playUrl = (await ensureRemux(key, { url: v.url!, headers: v.headers, input: 'ts' }, src.secrets || [], viewer)).playUrl;
      recorded = true;
    } catch (e) {
      verdicts.delete(key);
      const m = (e as Error).message;
      log(`tune ${p.name} / ${cleanChannelName(c.name)}: remux failed: ${m}`);
      return { key, state: /ffmpeg is not installed/.test(m) ? 'unsupported' : 'unavailable', detail: 'remux', message: /ffmpeg is not installed/.test(m) ? m : `The stream could not be read (${m}).`, elapsedMs: Date.now() - t0 };
    }
  } else if (v.kind === 'progressive') playUrl = `/api/livetv/file/${encodeURIComponent(key)}`;
  else playUrl = `/api/livetv/hls/${encodeURIComponent(key)}/index.m3u8`;
  log(`tune ${p.name} / ${cleanChannelName(c.name)}: ${v.kind} from ${safeHost(v.url || '')}, ${Date.now() - t0} ms`);
  return { key, state: 'ok', kind: v.kind, playUrl, detail, message, dvr: recorded, windowSec: recorded ? DVR_WINDOW_SEC : undefined, elapsedMs: Date.now() - t0 };
}

// ---------------------------------------------------------------- preferences

export function setPrefs(patch: LiveTvPrefsPatch): LiveTvPrefs {
  const pr = loadPrefs();
  let dirty = false;
  if (patch.favorite && typeof patch.favorite.key === 'string') {
    const k = patch.favorite.key;
    const has = pr.favorites.includes(k);
    if (patch.favorite.on && !has) {
      if (!findChannel(k)) throw new LiveTvError('Unknown channel', 404);
      pr.favorites.push(k);
      pr.hidden = pr.hidden.filter((x) => x !== k); // a favorite is never hidden
      dirty = true;
    } else if (!patch.favorite.on && has) {
      pr.favorites = pr.favorites.filter((x) => x !== k);
      dirty = true;
    }
  }
  if (patch.hidden && typeof patch.hidden.key === 'string') {
    const k = patch.hidden.key;
    const has = pr.hidden.includes(k);
    if (patch.hidden.on && !has) {
      if (!findChannel(k)) throw new LiveTvError('Unknown channel', 404);
      pr.hidden.push(k);
      pr.favorites = pr.favorites.filter((x) => x !== k);
      if (pr.lastKey === k) pr.lastKey = undefined;
      dirty = true;
    } else if (!patch.hidden.on && has) {
      pr.hidden = pr.hidden.filter((x) => x !== k);
      dirty = true;
    }
  }
  if (patch.unhideAll && pr.hidden.length) {
    pr.hidden = [];
    dirty = true;
  }
  if (patch.lastKey !== undefined) {
    if (patch.lastKey === null) {
      if (pr.lastKey) dirty = true;
      pr.lastKey = undefined;
    } else if (typeof patch.lastKey === 'string' && findChannel(patch.lastKey)) {
      pr.lastKey = patch.lastKey;
      pr.lastAt = Date.now();
      dirty = true;
    }
  }
  if (dirty) prefsChanged();
  return pr;
}

export const liveTvStats = (): Record<string, unknown> => ({ providers: load().providers.length, channels: [...lists.values()].reduce((n, l) => n + (l?.channels.length || 0), 0), refreshing: [...running.keys()], verdicts: verdicts.size, remux: remuxStats() });

// ---------------------------------------------------------------- routes

export function registerLiveTv(app: FastifyInstance): void {
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown): unknown => {
    const err = e as { message?: string; status?: number };
    const status = e instanceof LiveTvError || e instanceof XtreamError ? err.status || 400 : 502;
    return reply.code(status).send({ error: err.message || String(e) });
  };
  const limited = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.get<{ Querystring: { rev?: string } }>('/api/livetv', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = await liveTvState();
    if (req.query.rev !== undefined && Number(req.query.rev) === s.rev) return { rev: s.rev, channelsRev: s.channelsRev, unchanged: true };
    return s;
  });
  app.get<{ Querystring: { rev?: string } }>('/api/livetv/channels', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { channelsRev } = liveTvRev();
    if (req.query.rev !== undefined && Number(req.query.rev) === channelsRev) return { channelsRev, unchanged: true };
    return liveTvChannels();
  });
  app.get('/api/livetv/presets', async () => ({ presets: LIVETV_PRESETS }));
  app.post<{ Body: LiveTvProviderInput }>('/api/livetv/providers', limited, async (req, reply) => {
    try {
      return { provider: await addProvider(req.body || {}), state: await liveTvState() };
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post<{ Params: { id: string }; Body: LiveTvProviderInput }>('/api/livetv/providers/:id', limited, async (req, reply) => {
    try {
      return { provider: await updateProvider(req.params.id, req.body || {}), state: await liveTvState() };
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>('/api/livetv/providers/:id/delete', async (req, reply) => {
    try {
      deleteProvider(req.params.id);
      return liveTvState();
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>('/api/livetv/providers/:id/refresh', limited, async (req, reply) => {
    try {
      void refreshProvider(req.params.id).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      return liveTvState();
    } catch (e) {
      return fail(reply, e);
    }
  });
  // A connection test: for a form being filled in (the fields) or a saved provider (its id; typed fields override)
  app.post<{ Body: LiveTvTestRequest }>('/api/livetv/providers/test', limited, async (req) => testProvider(req.body || {}));
  app.post<{ Body: LiveTvTuneRequest }>('/api/livetv/tune', limited, async (req, reply) => {
    try {
      const key = String(req.body?.key || '');
      if (!key) throw new LiveTvError('Which channel?');
      return await tune(key, req.body?.dvr !== false, cleanViewer(req.body?.viewer));
    } catch (e) {
      return fail(reply, e);
    }
  });
  // the player left a channel (switched, closed, or the page went away: a beacon): its recorder stops soon
  app.post<{ Body: LiveTvLeaveRequest }>('/api/livetv/leave', async (req) => {
    const key = String(req.body?.key || '');
    const viewer = cleanViewer(req.body?.viewer);
    if (key && viewer) leaveRemux(key, viewer);
    return { ok: true };
  });
  app.post<{ Body: LiveTvPrefsPatch }>('/api/livetv/prefs', async (req, reply) => {
    try {
      return setPrefs(req.body || {});
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get<{ Querystring: { keys?: string } }>('/api/livetv/guide', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return guideNow(String(req.query.keys || '').split(',').filter(Boolean));
  });
  app.get<{ Params: { key: string } }>('/api/livetv/guide/:key', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      return guideFor(req.params.key);
    } catch (e) {
      return fail(reply, e);
    }
  });
  registerLiveTvStreamRoutes(app, async (key) => sourceOf(key), (key) => verdicts.get(key));
}
