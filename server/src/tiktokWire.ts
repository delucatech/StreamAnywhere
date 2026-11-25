/**
 * What the signed-in browser's OWN For You request carries - looked at, never touched.
 *
 * Why (2026-11-25): comments, profiles and Explore are read without a browser now (tiktokGuest.ts),
 * and the question is whether the personalised For You could be too. Before anything is tried with
 * the account, this answers whether it is possible at all: does the page prove, with every request,
 * that it holds a key that cannot leave the browser ("ticket guard")? If it does, no code outside
 * the browser can make that request, and the question is closed without a single test request.
 *
 * Nothing here makes a request to TikTok. It listens (a second DevTools session on the page the
 * server already has on /foryou) to the requests the page makes by itself, and can read the names
 * and shapes of what the page keeps in its storage. NAMES AND SIZES ONLY: a header, cookie or
 * parameter is recorded as its name and the length of its value; values are kept for a short list
 * of version numbers and fixed words that identify nothing. Kept in memory (the last few requests),
 * served by GET /api/session/wire (site password).
 */
import * as zlib from 'node:zlib';

type Page = import('puppeteer-core').Page;

export interface WireField {
  name: string;
  /** Length of the value in characters */
  len: number;
  /** Only for the fixed words and version numbers in SHOWN_* */
  value?: string;
}

export interface WireRecord {
  at: string;
  method: string;
  path: string;
  query: WireField[];
  /** Everything the browser put on the wire (the network stack's own headers included), except Cookie: that is `cookies` */
  headers: WireField[];
  cookies: WireField[];
  /** A POST's body: its size on the wire, whether it was compressed, and - when it is JSON - its top-level field names with the length of each value */
  body?: { bytes: number; gzip: boolean; fields?: WireField[]; note?: string };
  status?: number;
  responseHeaders?: WireField[];
}

/** The requests worth looking at: the For You list, and the page's key registration / proof calls if it makes any. */
const WATCHED = /\/api\/recommend\/item_list\/|ticket[_-]?guard|\/passport\/web\/(account\/info|public_key|get_public_key)|\/api\/(following|friends)\/item_list\//i;
/** Values that identify nothing and say a lot: version numbers, fixed words. */
const SHOWN_HEADERS = /^(tt-ticket-guard-(version|iteration-version|web-version|result|client-version)|x-tt-ticket-guard-.*version.*|sec-fetch-(site|mode|dest)|sec-ch-ua-(mobile|platform)|content-type|x-secsdk-csrf-(version|request)|x-ware-csrf-token-version|tt-ticket-guard-web-domain)$/i;
const SHOWN_QUERY = /^(aid|app_name|channel|count|from_page|pullType|device_platform|os|coverFormat|isNonPersonalized|history_len|X-Bogus|browser_name|browser_platform|user_is_login|data_collection_enabled|itemID|vv_count_fyp|watchLiveLastTime|showAds|showAboutThisAd|clientABVersions)$/;
const KEEP = 6;

const records: WireRecord[] = [];
const watched = new WeakSet<Page>();
let lastError: string | undefined;

const field = (name: string, value: unknown, shown: RegExp): WireField => {
  const v = String(value ?? '');
  // (X-Bogus only when it is the short literal the page sends on plain requests; a real signature stays a length)
  return shown.test(name) && v.length <= 48 ? { name, len: v.length, value: v } : { name, len: v.length };
};

const fields = (headers: Record<string, unknown> | undefined, shown: RegExp, skip?: RegExp): WireField[] =>
  Object.entries(headers || {})
    .filter(([k]) => !skip?.test(k))
    .map(([k, v]) => field(k, v, shown))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

/** A Cookie header as cookie names with the length of each value. */
export function cookieFields(header: unknown): WireField[] {
  return String(header ?? '')
    .split(/;\s*/)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq > 0 ? { name: pair.slice(0, eq).trim(), len: pair.length - eq - 1 } : undefined;
    })
    .filter((c): c is WireField => Boolean(c && c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A request body (the bytes the page sent) as its size and, when it is JSON (gzipped or not), its top-level field names and value lengths. */
export function bodyFields(bytes: Buffer): NonNullable<WireRecord['body']> {
  const gzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const out: NonNullable<WireRecord['body']> = { bytes: bytes.length, gzip };
  try {
    const text = (gzip ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      out.fields = Object.entries(json).map(([k, v]) => ({ name: `${k}${Array.isArray(v) ? `[${v.length}]` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 12).join(',')}}` : ''}`.slice(0, 160), len: (typeof v === 'string' ? v : JSON.stringify(v) ?? '').length }));
    } else out.note = Array.isArray(json) ? `a JSON array of ${json.length}` : `JSON ${typeof json}`;
  } catch {
    out.note = 'not JSON';
  }
  return out;
}

/** A request URL as its path and its parameters (names and lengths; values for the fixed words). */
export function urlFields(url: string): { path: string; query: WireField[] } {
  try {
    const u = new URL(url);
    return { path: u.host + u.pathname, query: [...u.searchParams].map(([k, v]) => field(k, v, SHOWN_QUERY)) };
  } catch {
    return { path: url.slice(0, 80), query: [] };
  }
}

/**
 * Starts listening on `page` (once per page). The page's own requests are not changed or delayed:
 * this is a second DevTools session that only receives the network events.
 */
export async function watchWire(page: Page, log?: (m: string) => void): Promise<void> {
  if (watched.has(page)) return;
  watched.add(page);
  try {
    const cdp = await page.target().createCDPSession();
    const byId = new Map<string, WireRecord>();
    /** The network stack's own view of a request can arrive before the page-level event: kept until it does */
    const early = new Map<string, { headers?: Record<string, unknown>; response?: { status: number; headers: Record<string, unknown> } }>();
    const trim = (m: Map<string, unknown>): void => {
      while (m.size > 200) m.delete(m.keys().next().value as string);
    };
    const applyExtra = (rec: WireRecord, headers: Record<string, unknown>): void => {
      const cookie = Object.entries(headers).find(([k]) => k.toLowerCase() === 'cookie')?.[1];
      rec.headers = fields(headers, SHOWN_HEADERS, /^(cookie|:authority|:method|:path|:scheme)$/i);
      if (cookie !== undefined) rec.cookies = cookieFields(cookie);
    };
    cdp.on('Network.requestWillBeSent', (e: any) => {
      const url: string = e?.request?.url || '';
      if (!WATCHED.test(url)) return;
      const { path, query } = urlFields(url);
      const rec: WireRecord = { at: new Date().toISOString(), method: e.request.method, path, query, headers: fields(e.request.headers, SHOWN_HEADERS, /^cookie$/i), cookies: [] };
      try {
        // The body as the page handed it over (base64 pieces); its field names only.
        const pieces: Array<{ bytes?: string }> = Array.isArray(e.request.postDataEntries) ? e.request.postDataEntries : [];
        if (pieces.length) rec.body = bodyFields(Buffer.concat(pieces.map((x) => Buffer.from(x.bytes || '', 'base64'))));
        else if (typeof e.request.postData === 'string' && e.request.postData) rec.body = bodyFields(Buffer.from(e.request.postData, 'utf8'));
        else if (e.request.hasPostData) {
          // Not in the event (a large or binary body): asked for separately. A compressed body can come back
          // damaged as text; then its size is what is learned.
          rec.body = { bytes: 0, gzip: false, note: 'a body the browser did not hand over' };
          cdp
            .send('Network.getRequestPostData', { requestId: e.requestId })
            .then((r: any) => {
              const text = typeof r?.postData === 'string' ? r.postData : '';
              if (!text) return;
              const asBytes = Buffer.from(text, r.base64Encoded ? 'base64' : 'latin1');
              const viaLatin1 = bodyFields(asBytes);
              rec.body = viaLatin1.fields || viaLatin1.gzip ? viaLatin1 : bodyFields(Buffer.from(text, 'utf8'));
            })
            .catch(() => undefined);
        }
      } catch {
        /* the body stays unrecorded */
      }
      byId.set(e.requestId, rec);
      trim(byId);
      const before = early.get(e.requestId);
      if (before?.headers) applyExtra(rec, before.headers);
      if (before?.response) {
        rec.status = before.response.status;
        rec.responseHeaders = fields(before.response.headers, SHOWN_HEADERS, /^set-cookie$/i);
      }
      early.delete(e.requestId);
      records.push(rec);
      if (records.length > KEEP) records.splice(0, records.length - KEEP);
      log?.(`wire: the page asked ${path} (${rec.query.length} parameters, ${rec.headers.length} headers)`);
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (e: any) => {
      const rec = byId.get(e.requestId);
      if (rec) applyExtra(rec, e.headers || {});
      else {
        early.set(e.requestId, { ...(early.get(e.requestId) || {}), headers: e.headers || {} });
        trim(early);
      }
    });
    cdp.on('Network.responseReceivedExtraInfo', (e: any) => {
      const rec = byId.get(e.requestId);
      if (rec) {
        rec.status = e.statusCode;
        rec.responseHeaders = fields(e.headers, SHOWN_HEADERS, /^set-cookie$/i);
      } else {
        early.set(e.requestId, { ...(early.get(e.requestId) || {}), response: { status: e.statusCode, headers: e.headers || {} } });
        trim(early);
      }
    });
    await cdp.send('Network.enable');
  } catch (e) {
    lastError = (e as Error).message;
    log?.(`wire: could not listen to the page's requests (${lastError})`);
  }
}

/**
 * Runs in the page: the NAMES of what it keeps (localStorage / sessionStorage keys that look like
 * keys or guards, every IndexedDB database and store), and for each stored record its shape - a
 * string as its length, an object as its field names, a key object (CryptoKey) as its type,
 * algorithm, uses and whether it can be exported. No value leaves the page.
 */
export const READ_STORAGE_SHAPES = `(async () => {
  const out = { origin: location.origin, step: 'start', localStorage: [], sessionStorage: [], indexedDB: [] };
  window.__saStorageShapes = out;
  const like = /ticket|guard|key|sign|crypto|secsdk|token|xmst|webid|device/i;
  for (const store of ['localStorage', 'sessionStorage']) {
    try {
      const st = window[store];
      out[store + 'Count'] = st.length;
      for (let i = 0; i < st.length; i++) { const k = st.key(i); if (like.test(k)) out[store].push({ name: String(k).slice(0, 80), len: (st.getItem(k) || '').length }); }
    } catch (e) { out[store + 'Error'] = String(e); }
  }
  const shape = (v, depth) => {
    if (v === null || v === undefined) return String(v);
    if (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) return { cryptoKey: true, type: v.type, extractable: v.extractable, algorithm: Object.assign({}, v.algorithm, v.algorithm && v.algorithm.hash ? { hash: v.algorithm.hash.name } : {}, v.algorithm && v.algorithm.publicExponent ? { publicExponent: undefined } : {}), usages: v.usages };
    if (typeof v === 'string') return 'string(' + v.length + ')';
    if (typeof v === 'number' || typeof v === 'boolean') return typeof v;
    if (v instanceof ArrayBuffer) return 'bytes(' + v.byteLength + ')';
    if (ArrayBuffer.isView(v)) return 'bytes(' + v.byteLength + ')';
    if (Array.isArray(v)) return depth > 2 ? 'array(' + v.length + ')' : ['array(' + v.length + ')'].concat(v.slice(0, 2).map((x) => shape(x, depth + 1)));
    if (typeof v === 'object') { if (depth > 2) return 'object'; const o = {}; for (const k of Object.keys(v).slice(0, 24)) o[String(k).slice(0, 60)] = shape(v[k], depth + 1); return o; }
    return typeof v;
  };
  let dbs = [];
  out.step = 'listing the databases';
  try { dbs = indexedDB.databases ? await indexedDB.databases() : []; } catch (e) { out.indexedDBError = String(e); }
  out.databaseNames = dbs.map((d) => d.name);
  for (const d of dbs) {
    const entry = { name: d.name, version: d.version, stores: [] };
    out.indexedDB.push(entry);
    out.step = 'reading database ' + d.name;
    await new Promise((done) => {
      let rq;
      try { rq = indexedDB.open(d.name); } catch (e) { entry.error = String(e); done(); return; }
      const timer = setTimeout(done, 4000);
      rq.onerror = () => { clearTimeout(timer); entry.error = 'could not be opened'; done(); };
      rq.onsuccess = () => {
        const db = rq.result;
        const names = Array.from(db.objectStoreNames);
        let left = names.length;
        const end = () => { if (--left <= 0) { clearTimeout(timer); try { db.close(); } catch (e) {} done(); } };
        if (!left) { left = 1; end(); return; }
        for (const n of names) {
          const st = { name: n, records: [] };
          entry.stores.push(st);
          try {
            const os = db.transaction(n, 'readonly').objectStore(n);
            const cnt = os.count(); cnt.onsuccess = () => { st.count = cnt.result; };
            const c = os.openCursor();
            let seen = 0;
            c.onsuccess = () => { const cur = c.result; if (cur && seen < 6) { seen++; const key = typeof cur.key === 'string' ? (cur.key.length > 40 ? 'string(' + cur.key.length + ')' : cur.key) : typeof cur.key; st.records.push({ key, value: shape(cur.value, 0) }); cur.continue(); } else end(); };
            c.onerror = () => { st.error = 'could not be read'; end(); };
          } catch (e) { st.error = String(e); end(); }
        }
      };
    });
  }
  out.step = 'done';
  return out;
})()`;

/** What the walk above had read when it was last looked at (it leaves its result so far on the page). */
export const READ_STORAGE_SHAPES_SO_FAR = 'window.__saStorageShapes || null';

/** Whether any stored shape is a key object, and whether one of them cannot be exported. */
export function summarizeKeys(shapes: unknown): { keys: number; lockedKeys: number; where: string[] } {
  const where: string[] = [];
  let keys = 0;
  let locked = 0;
  const walk = (v: unknown, at: string): void => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o.cryptoKey === true) {
      keys++;
      if (o.extractable === false) locked++;
      where.push(`${at}: ${String(o.type)} key, ${String((o.algorithm as { name?: string } | undefined)?.name ?? '?')}, uses ${JSON.stringify(o.usages)}, ${o.extractable === false ? 'CANNOT be exported' : 'can be exported'}`);
      return;
    }
    for (const [k, x] of Object.entries(o)) walk(x, Array.isArray(v) ? at : `${at}/${k}`);
  };
  const idb = (shapes as { indexedDB?: Array<{ name?: string; stores?: Array<{ name?: string; records?: unknown[] }> }> } | undefined)?.indexedDB;
  for (const db of Array.isArray(idb) ? idb : []) for (const st of db.stores || []) for (const r of st.records || []) walk(r, `${db.name}/${st.name}`);
  return { keys, lockedKeys: locked, where };
}

export function wireRecords(): { records: WireRecord[]; error?: string } {
  return { records: records.slice(), error: lastError };
}

/** Tests: forget what was recorded. */
export function resetWire(): void {
  records.length = 0;
  lastError = undefined;
}
