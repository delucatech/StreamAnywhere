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
