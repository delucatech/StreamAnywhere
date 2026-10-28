/**
 * Programme guides (XMLTV): one per provider, from the URL the provider names (an explicit one,
 * the playlist's url-tvg, or an Xtream panel's xmltv.php). Guide files run to hundreds of MB
 * uncompressed, so they are parsed as they arrive (gunzipped on the fly) and only the programmes
 * of the provider's own channels within a window around now are kept: the memory holds a few
 * MB per provider, and the parsed guide is written next to the channel cache so a restart does
 * not fetch it again. A guide is loaded in the background and refreshed after EPG_TTL_MS when
 * someone asks for it.
 *
 * Channels are matched to the guide by their id (tvg-id / epg_channel_id; "CNN.us@SD" also tries
 * "CNN.us"), else by display name (lower-cased, without the "(720p)" / "[Geo-blocked]" tags).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { PassThrough } from 'node:stream';
import type { LiveTvProgramme } from '../../shared/types';
import { isGzip, openLive, safeHost } from './livetvHttp';
import { cleanChannelName } from './livetvM3u';

export const EPG_TTL_MS = 6 * 60 * 60 * 1000;
/** Programmes kept: from 4 h ago to 40 h ahead */
const PAST_MS = 4 * 3600_000;
const FUTURE_MS = 40 * 3600_000;
const MAX_PROGRAMMES = 400_000;
const MAX_BYTES = 512 * 1024 * 1024;

export interface EpgStore {
  at: number;
  url: string;
  /** guide channel id -> programmes sorted by start */
  byId: Record<string, LiveTvProgramme[]>;
  /** normalized display name -> guide channel id (every channel of the guide, matched or not) */
  names: Record<string, string>;
  programmes: number;
  /** how many of the provider's channels found programmes */
  channels: number;
}

export interface EpgWanted {
  ids: Set<string>;
  /** channel names as the playlist gives them */
  names: Set<string>;
}

/** The words of a channel name that identify it: lower-case, without the quality / "channel" / "tv" filler */
export const nameWords = (s: string): string[] =>
  cleanChannelName(s)
    .toLowerCase()
    .replace(/\b(hd|sd|fhd|uhd|4k|channel|tv)\b/g, ' ')
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
export const normName = (s: string): string => nameWords(s).join('');

/**
 * The guide channel a playlist channel maps to: its id (or the id without the "@region" suffix),
 * else its name; else, for a regional variant the guide spells differently ("BBC One East
 * Midlands" vs "BBC One Lon HD"), the shortest guide name that starts with the first words of
 * the channel's name (at least two words), so the variant shows the main listing.
 */
export function resolveGuideId(store: { byId: Record<string, LiveTvProgramme[]> | Set<string>; names: Record<string, string> }, epgId: string | undefined, name: string): string | undefined {
  const has = (id: string): boolean => (store.byId instanceof Set ? store.byId.has(id) : Boolean(store.byId[id]));
  if (epgId) for (const v of idVariants(epgId)) if (has(v)) return v;
  const words = nameWords(name);
  const exact = store.names[words.join('')];
  if (exact) return exact;
  const sorted = sortedNames(store.names);
  for (let n = words.length; n >= 2; n--) {
    const prefix = words.slice(0, n).join('');
    if (prefix.length < 5) break;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const best = sorted
      .slice(lo, lo + 40)
      .filter((x) => x.startsWith(prefix))
      .sort((a, b) => a.length - b.length)[0];
    if (best) return store.names[best];
  }
  return undefined;
}
const sortedCache = new WeakMap<Record<string, string>, string[]>();
function sortedNames(names: Record<string, string>): string[] {
  let s = sortedCache.get(names);
  if (!s) {
    s = Object.keys(names).sort();
    sortedCache.set(names, s);
  }
  return s;
}

const idVariants = (id: string): string[] => {
  const out = [id];
  const at = id.indexOf('@');
  if (at > 0) out.push(id.slice(0, at));
  return out;
};

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
      const l = e.toLowerCase();
      if (l === 'amp') return '&';
      if (l === 'lt') return '<';
      if (l === 'gt') return '>';
      if (l === 'quot') return '"';
      if (l === 'apos') return "'";
      try {
        return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
      } catch {
        return m;
      }
    })
    .trim();

/** "20261028120000 +0000" -> ms (local time when no zone is given) */
export function parseXmltvTime(s: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*(?:([+-])(\d{2})(\d{2}))?/.exec(String(s || '').trim());
  if (!m) return undefined;
  const [, y, mo, d, h = '00', mi = '00', se = '00', sign, zh, zm] = m;
  if (sign) {
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    const off = (+zh * 60 + +zm) * 60_000;
    return sign === '+' ? utc - off : utc + off;
  }
  return new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime();
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? m[2] ?? m[3] : undefined;
};
const firstTag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : undefined;
};

/**
 * Incremental XMLTV scanner: feed it text as it arrives; it pulls complete <channel> and
 * <programme> elements out and keeps what is wanted.
 */
export class XmltvScanner {
  private buf = '';
  readonly names: Record<string, string> = {};
  readonly byId: Record<string, LiveTvProgramme[]> = {};
  programmes = 0;
  private wantedIds?: Set<string>;
  private readonly now: number;
  constructor(private readonly wanted: EpgWanted, now = Date.now()) {
    this.now = now;
  }

  /** The guide ids worth keeping: the wanted ids, plus the ids of guide channels whose name matches a wanted name */
  private targets(): Set<string> {
    if (this.wantedIds) return this.wantedIds;
    const ids = new Set<string>();
    const known = new Set(Object.values(this.names));
    for (const id of this.wanted.ids) for (const v of idVariants(id)) if (known.has(v)) ids.add(v);
    for (const n of this.wanted.names) {
      const id = resolveGuideId({ byId: known, names: this.names }, undefined, n);
      if (id) ids.add(id);
    }
    this.wantedIds = ids;
    return ids;
  }

  feed(text: string): void {
    this.buf += text;
    for (;;) {
      const c = this.buf.indexOf('<channel ');
      const p = this.buf.indexOf('<programme ');
      const i = c < 0 ? p : p < 0 ? c : Math.min(c, p);
      if (i < 0) {
        // keep a tail in case a tag start is split across chunks
        if (this.buf.length > 64) this.buf = this.buf.slice(-64);
        return;
      }
      const isChannel = i === c;
      const close = isChannel ? '</channel>' : '</programme>';
      const j = this.buf.indexOf(close, i);
      if (j < 0) {
        if (i > 0) this.buf = this.buf.slice(i);
        return;
      }
      const el = this.buf.slice(i, j + close.length);
      this.buf = this.buf.slice(j + close.length);
      const openEnd = el.indexOf('>');
      const tag = el.slice(0, openEnd);
      if (isChannel) {
        const id = attr(tag, 'id');
        if (!id) continue;
        for (const m of el.matchAll(/<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name>/gi)) {
          const n = normName(decode(m[1]));
          if (n && !this.names[n]) this.names[n] = id;
        }
        continue;
      }
      const channel = attr(tag, 'channel');
      if (!channel || !this.targets().has(channel)) continue;
      const start = parseXmltvTime(attr(tag, 'start') || '');
      const stop = parseXmltvTime(attr(tag, 'stop') || '');
      if (start === undefined || stop === undefined) continue;
      if (stop < this.now - PAST_MS || start > this.now + FUTURE_MS) continue;
      if (this.programmes >= MAX_PROGRAMMES) continue;
      const title = firstTag(el, 'title') || '';
      if (!title) continue;
      const prog: LiveTvProgramme = { start, stop, title };
      const desc = firstTag(el, 'desc');
      if (desc) prog.desc = desc.slice(0, 600);
      const cat = firstTag(el, 'category');
      if (cat) prog.category = cat;
      (this.byId[channel] ||= []).push(prog);
      this.programmes++;
    }
  }

  finish(): void {
    for (const list of Object.values(this.byId)) list.sort((a, b) => a.start - b.start);
  }
}

/** Fetches and parses a guide (gzip or plain), keeping the programmes of `wanted`. */
export async function fetchEpg(url: string, wanted: EpgWanted, log: (m: string) => void): Promise<EpgStore> {
  const t0 = Date.now();
  const { res, status, finalUrl } = await openLive(url, { timeoutMs: 60_000 });
  if (status >= 400) {
    res.resume();
    throw new Error(`HTTP ${status} from ${safeHost(finalUrl)}`);
  }
  const scanner = new XmltvScanner(wanted);
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    let out: NodeJS.ReadableStream | undefined;
    const first = (chunk: Buffer): void => {
      res.off('data', first);
      res.pause();
      const sink = new PassThrough();
      out = isGzip(chunk) ? sink.pipe(zlib.createGunzip()) : sink;
      out.on('data', (d: Buffer) => {
        bytes += d.length;
        if (bytes > MAX_BYTES) {
          res.destroy();
          reject(new Error(`The guide is larger than ${MAX_BYTES / 1048576} MB`));
          return;
        }
        scanner.feed(decoder.decode(d, { stream: true }));
      });
      out.on('end', () => resolve());
      out.on('error', reject);
      sink.write(chunk);
      res.pipe(sink);
      res.resume();
    };
    res.on('data', first);
    res.on('error', reject);
    res.on('end', () => {
      if (!out) resolve();
    });
  });
  scanner.finish();
  const store: EpgStore = { at: Date.now(), url, byId: scanner.byId, names: scanner.names, programmes: scanner.programmes, channels: Object.keys(scanner.byId).length };
  log(`guide from ${safeHost(url)}: ${Math.round(bytes / 1048576)} MB, ${store.programmes} programmes for ${store.channels} channels, ${Date.now() - t0} ms`);
  return store;
}

// ---------------------------------------------------------------- the per-provider stores

const stores = new Map<string, EpgStore>();
const loading = new Map<string, Promise<EpgStore>>();
let dir = '';
export const setEpgDir = (d: string): void => {
  dir = d;
};
const fileOf = (providerId: string): string => path.join(dir, `${providerId}.epg.json`);

export function epgStore(providerId: string): EpgStore | undefined {
  let s = stores.get(providerId);
  if (!s && dir) {
    try {
      s = JSON.parse(fs.readFileSync(fileOf(providerId), 'utf8')) as EpgStore;
      stores.set(providerId, s);
    } catch {
      /* none on disk */
    }
  }
  return s;
}
export const epgLoading = (providerId: string): boolean => loading.has(providerId);

export function forgetEpg(providerId: string): void {
  stores.delete(providerId);
  try {
    fs.unlinkSync(fileOf(providerId));
  } catch {
    /* none */
  }
}

/** Loads (or reloads) a provider's guide once; concurrent callers share the load. */
export function loadEpg(providerId: string, url: string, wanted: EpgWanted, log: (m: string) => void): Promise<EpgStore> {
  let p = loading.get(providerId);
  if (p) return p;
  p = fetchEpg(url, wanted, log)
    .then((store) => {
      stores.set(providerId, store);
      if (dir) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          const tmp = `${fileOf(providerId)}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(store));
          fs.renameSync(tmp, fileOf(providerId));
        } catch (e) {
          log(`guide of ${providerId} not saved: ${(e as Error).message}`);
        }
      }
      return store;
    })
    .finally(() => loading.delete(providerId));
  loading.set(providerId, p);
  return p;
}

/** The programmes of one channel in a provider's guide (by id, its variants, or its name). */
export function programmesFor(store: EpgStore, epgId: string | undefined, name: string): LiveTvProgramme[] | undefined {
  const id = resolveGuideId(store, epgId, name);
  return id ? store.byId[id] : undefined;
}

export function nowNext(list: LiveTvProgramme[], now = Date.now()): { now?: LiveTvProgramme; next?: LiveTvProgramme } {
  // sorted by start: the first programme that has not ended
  let i = 0;
  while (i < list.length && list[i].stop <= now) i++;
  const cur = list[i];
  if (!cur) return {};
  if (cur.start <= now) return { now: cur, next: list[i + 1] };
  return { next: cur };
}
