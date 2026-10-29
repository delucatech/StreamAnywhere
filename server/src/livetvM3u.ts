/**
 * M3U / M3U8 playlist parsing (IPTV lists): #EXTINF lines with tvg-* attributes, group titles,
 * #EXTGRP, the VLC / Kodi per-channel options some lists carry (a User-Agent or Referer the
 * stream needs; DRM license keys, which mark the channel as unplayable here), and the playlist's
 * own guide URL (url-tvg / x-tvg-url on the #EXTM3U line).
 */
import * as crypto from 'node:crypto';

export interface M3uChannel {
  /** Stable within the playlist: the guide id and name when there is one, else the URL (hashed) */
  id: string;
  name: string;
  group: string;
  logo?: string;
  epgId?: string;
  number?: number;
  url: string;
  /** Request headers the list asks for (#EXTVLCOPT http-user-agent / http-referrer, #KODIPROP) */
  headers?: Record<string, string>;
  drm?: boolean;
}

export interface M3uPlaylist {
  channels: M3uChannel[];
  /** Guide URLs named on the #EXTM3U line (several when the list lists several) */
  epgUrls: string[];
  /** Lines that were not understood (counted, for the log) */
  skipped: number;
}

/** key="value" or key=value pairs of an #EXTINF line (values may hold spaces inside quotes) */
export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_.-]+)=("([^"]*)"|'([^']*)'|([^\s,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').trim();
  return out;
}

/**
 * "Animation;Kids" -> ["Animation", "Kids"]: iptv-org (and lists made from it) join a channel's
 * categories with semicolons in one group-title; each is a group of its own. Trimmed, no
 * empties, no repeats.
 */
export function splitGroups(group: string): string[] {
  const out: string[] = [];
  for (const g of (group || '').split(';')) {
    const t = g.replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The distinct groups across a channel list (each semicolon-joined category counted apart) */
export function countGroups(channels: { group: string }[]): number {
  const set = new Set<string>();
  for (const c of channels) for (const g of splitGroups(c.group)) set.add(g);
  return set.size;
}

const shortHash = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** "CNN HD (720p) [Geo-blocked]" -> "CNN HD": the name without the quality / availability tags lists append */
export function cleanChannelName(name: string): string {
  return name
    .replace(/\s*\[(geo-?blocked|not 24\/7|ssl|timeshift|vpn)[^\]]*\]/gi, '')
    .replace(/\s*\((\d{3,4}p|sd|hd|fhd|uhd|4k)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A name as an identity: lower-case, quality words dropped ("CNN HD" = "CNN"), punctuation gone
 * but for "+" ("News 12+" is not "News 12", "Canal+" not "Canal"). Empty when nothing but quality words is left.
 */
export function channelNameKey(name: string): string {
  return cleanChannelName(name)
    .toLowerCase()
    .replace(/\b(hd|sd|fhd|uhd|4k|hevc|h\.?265)\b/g, ' ')
    .replace(/[^a-z0-9+]+/g, '');
}

/** "(1080p)" / "(720p)" from a raw playlist name */
export function qualityOf(name: string): string | undefined {
  const m = /\((\d{3,4}p)\)/i.exec(name);
  return m ? m[1].toLowerCase() : undefined;
}

/** What the merge needs of one playlist entry of one provider */
export interface MergeEntry {
  key: string;
  providerId: string;
  /** The cleaned name (what the tile shows) */
  name: string;
  /** The list's own name, with its quality tag */
  rawName: string;
  epgId?: string;
  url: string;
  groups: string[];
  logo?: string;
  number?: number;
  drm?: boolean;
}

export interface MergedChannel {
  key: string;
  providerId: string;
  name: string;
  group: string;
  groups: string[];
  logo?: string;
  epgId?: string;
  number?: number;
  drm?: boolean;
  sources: { key: string; providerId: string; name: string; quality?: string; drm?: boolean }[];
  keys: string[];
}

/**
 * Entries that are the same channel become one, in the order the first of them came: the same
 * stream URL (a country list and a category list naming the same entry), the same guide id in
 * full ("CNN.us@SD" twice; "CNN.us@HD" is another stream of it only through the name), or the
 * same name within one country (the guide id's "…​.us") or, without a guide id, within one
 * provider ("CNN" and "CNN HD"; never "CBS KUTV" and "CBS KIRO-TV", whose names differ). The
 * streams of a merged channel are its sources (one per URL, the ones without DRM first); every
 * entry's key is kept in `keys` so favorites and hidden lists made of any of them still match.
 */
export function mergeChannels(entries: MergeEntry[]): MergedChannel[] {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const firstBy = new Map<string, number>();
  const link = (ident: string, i: number): void => {
    const first = firstBy.get(ident);
    if (first === undefined) firstBy.set(ident, i);
    else union(first, i);
  };
  entries.forEach((e, i) => {
    link(`url:${e.url}`, i);
    const id = (e.epgId || '').trim().toLowerCase();
    if (id) link(`id:${id}`, i);
    const nameKey = channelNameKey(e.rawName);
    if (nameKey) {
      const country = /\.([a-z]{2})$/i.exec(id.split('@')[0] || '');
      link(`name:${nameKey}|${country ? country[1] : `p:${e.providerId}`}`, i);
    }
  });
  const groups = new Map<number, MergeEntry[]>();
  entries.forEach((e, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(e);
    else groups.set(r, [e]);
  });
  const out: MergedChannel[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    const seenUrl = new Set<string>();
    const sources: MergedChannel['sources'] = [];
    const gset = new Set<string>();
    const groupList: string[] = [];
    let logo: string | undefined;
    for (const e of g) {
      if (!seenUrl.has(e.url)) {
        seenUrl.add(e.url);
        const src: MergedChannel['sources'][number] = { key: e.key, providerId: e.providerId, name: e.name };
        const q = qualityOf(e.rawName);
        if (q) src.quality = q;
        if (e.drm) src.drm = true;
        sources.push(src);
      }
      for (const x of e.groups) if (!gset.has(x)) {
        gset.add(x);
        groupList.push(x);
      }
      if (!logo && e.logo) logo = e.logo;
    }
    // a stream without DRM before one with it (the player tries them in order); otherwise as listed
    sources.sort((a, b) => Number(!!a.drm) - Number(!!b.drm));
    const primary = sources[0];
    const ch: MergedChannel = { key: primary.key, providerId: primary.providerId, name: first.name, group: groupList[0] || '', groups: groupList, sources, keys: g.map((e) => e.key) };
    if (logo) ch.logo = logo;
    if (first.epgId) ch.epgId = first.epgId;
    if (first.number) ch.number = first.number;
    if (sources.every((s) => s.drm)) ch.drm = true;
    out.push(ch);
  }
  return out;
}

export function parseM3u(text: string): M3uPlaylist {
  const lines = text.split(/\r?\n/);
  const channels: M3uChannel[] = [];
  const epgUrls: string[] = [];
  let skipped = 0;
  let pending: (Partial<M3uChannel> & { rawName?: string }) | undefined;
  let currentGroup = '';
  const seen = new Map<string, number>();
  /**
   * Options written before the #EXTINF line (Kodi-style lists put #KODIPROP first; VLC lists put
   * #EXTVLCOPT after it): kept here until the next #EXTINF, then applied to it.
   */
  let ahead: { headers?: Record<string, string>; drm?: boolean } = {};
  const target = (): { headers?: Record<string, string>; drm?: boolean } => pending || ahead;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) {
      const a = parseAttrs(line.slice(7));
      const tvg = a['url-tvg'] || a['x-tvg-url'] || a['tvg-url'];
      if (tvg) for (const u of tvg.split(/[,\s]+/)) if (/^https?:\/\//i.test(u)) epgUrls.push(u);
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      // #EXTINF:-1 tvg-id="x" group-title="News",Channel name
      const body = line.slice(line.indexOf(':') + 1);
      const comma = nameComma(body);
      const attrs = parseAttrs(comma >= 0 ? body.slice(0, comma) : body);
      const rawName = (comma >= 0 ? body.slice(comma + 1) : '').trim();
      const name = rawName || attrs['tvg-name'] || '';
      const chno = Number(attrs['tvg-chno'] || attrs['channel-number'] || '');
      pending = {
        rawName,
        name,
        group: attrs['group-title'] || currentGroup || '',
        logo: attrs['tvg-logo'] || attrs.logo || undefined,
        epgId: attrs['tvg-id'] || undefined,
        number: Number.isFinite(chno) && chno > 0 ? chno : undefined,
        headers: ahead.headers,
        drm: ahead.drm,
      };
      ahead = {};
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      currentGroup = line.slice(8).trim();
      if (pending && !pending.group) pending.group = currentGroup;
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice(11);
      const eq = opt.indexOf('=');
      if (eq > 0) {
        const t = target();
        const k = opt.slice(0, eq).trim().toLowerCase();
        const v = opt.slice(eq + 1).trim();
        if (k === 'http-user-agent') t.headers = { ...(t.headers || {}), 'user-agent': v };
        else if (k === 'http-referrer' || k === 'http-referer') t.headers = { ...(t.headers || {}), referer: v };
        else if (k === 'http-origin') t.headers = { ...(t.headers || {}), origin: v };
      }
      continue;
    }
    if (line.startsWith('#KODIPROP:')) {
      const opt = line.slice(10);
      const eq = opt.indexOf('=');
      if (eq > 0) {
        const t = target();
        const k = opt.slice(0, eq).trim().toLowerCase();
        const v = opt.slice(eq + 1).trim();
        if (/license_key|license_type|drm/.test(k)) t.drm = true;
        else if (k === 'inputstream.adaptive.stream_headers' || k === 'inputstream.adaptive.manifest_headers') {
          for (const pair of v.split('&')) {
            const e2 = pair.indexOf('=');
            if (e2 > 0) t.headers = { ...(t.headers || {}), [decodeURIComponent(pair.slice(0, e2)).toLowerCase()]: decodeURIComponent(pair.slice(e2 + 1)) };
          }
        }
      }
      continue;
    }
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const obj = JSON.parse(line.slice(9)) as Record<string, string>;
        const t = target();
        t.headers = { ...(t.headers || {}) };
        for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') t.headers[k.toLowerCase()] = v;
      } catch {
        skipped++;
      }
      continue;
    }
    if (line.startsWith('#')) continue; // other comments / tags
    // a URL line
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
      skipped++;
      pending = undefined;
      continue;
    }
    const url = line;
    const p = pending || {};
    pending = undefined;
    const name = (p.name || '').trim() || nameFromUrl(url);
    const base = p.epgId ? `${p.epgId}|${name}` : url;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    channels.push({
      id: shortHash(n ? `${base}|${n}` : base),
      name,
      group: (p.group || '').trim(),
      logo: p.logo,
      epgId: p.epgId,
      number: p.number,
      url,
      headers: p.headers,
      drm: p.drm,
    });
  }
  return { channels, epgUrls, skipped };
}

/**
 * The comma that separates the attributes of an #EXTINF line from the channel name: the first
 * comma outside quotes (a comma inside a quoted attribute value, or in the name, is not it).
 */
function nameComma(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) return i;
  }
  return -1;
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return (last ? last.replace(/\.[a-z0-9]{2,5}$/i, '') : u.hostname) || u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}
