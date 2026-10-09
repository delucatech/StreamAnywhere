import type { MediaFormat, ResolveResponse } from '../../shared/types';
import { pressed } from './busy';
import { api, ApiError, apiUrl, getApiBase, setApiBase } from './api';
import { testFetch } from './cors-test';
import { initialResults, runExperiments, type ExperimentResult } from './diagnostics';
import { EmbedRenderer } from './renderers/embedRenderer';
import type { LoadSource, PlayerStats, Renderer, RendererEvents } from './renderers/types';
import { VideoElementRenderer } from './renderers/videoElementRenderer';
import { WebCodecsRenderer, webCodecsSupported } from './renderers/webcodecsRenderer';
import { DEFAULT_TIKTOK_URL, TEST_SOURCES } from './testSources';
import { $, clearLog, formatBytes, formatTime, log, setOverlay } from './ui';

type SourceMode = 'auto' | 'direct' | 'proxy' | 'test' | 'local';
type RendererKind = 'webcodecs' | 'video' | 'embed';

const el = {
  url: $<HTMLInputElement>('url'),
  load: $<HTMLButtonElement>('load'),
  source: $<HTMLSelectElement>('source'),
  renderer: $<HTMLSelectElement>('renderer'),
  test: $<HTMLSelectElement>('test'),
  testWrap: $('testWrap'),
  localWrap: $('localWrap'),
  file: $<HTMLInputElement>('file'),
  formatWrap: $('formatWrap'),
  format: $<HTMLSelectElement>('format'),
  resolveInfo: $('resolveInfo'),
  stage: $('stage'),
  canvas: $<HTMLCanvasElement>('canvas'),
  playPause: $<HTMLButtonElement>('playPause'),
  seek: $<HTMLInputElement>('seek'),
  timeNow: $('timeNow'),
  timeTotal: $('timeTotal'),
  volume: $<HTMLInputElement>('volume'),
  fullscreen: $<HTMLButtonElement>('fullscreen'),
  stats: $('stats'),
  support: $('support'),
  runTests: $<HTMLButtonElement>('runTests'),
  copyResults: $<HTMLButtonElement>('copyResults'),
  results: $<HTMLTableElement>('results'),
  clearLog: $<HTMLButtonElement>('clearLog'),
  apiBase: $<HTMLInputElement>('apiBase'),
  apiStatus: $('apiStatus'),
};

const state = {
  renderer: undefined as Renderer | undefined,
  rendererKind: 'webcodecs' as RendererKind,
  resolved: undefined as ResolveResponse | undefined,
  lastTikTok: undefined as ResolveResponse | undefined,
  current: undefined as LoadSource | undefined,
  seeking: false,
  localUrl: undefined as string | undefined,
  results: initialResults() as ExperimentResult[],
  reported: false,
};

// ---------- setup ----------
for (const t of TEST_SOURCES) {
  const o = document.createElement('option');
  o.value = t.url;
  o.textContent = t.label;
  o.title = t.note;
  el.test.appendChild(o);
}
el.url.value = DEFAULT_TIKTOK_URL;
updateSourceVisibility();

(function describeSupport() {
  const wc = webCodecsSupported();
  const lines = [
    `WebCodecs VideoDecoder: ${wc.ok ? 'yes' : 'no – ' + wc.reason}`,
    `AudioDecoder: ${typeof AudioDecoder !== 'undefined' ? 'yes' : 'no'}`,
    `requestVideoFrameCallback: ${'requestVideoFrameCallback' in HTMLVideoElement.prototype ? 'yes' : 'no'}`,
  ];
  el.support.textContent = lines.join('\n');
  if (!wc.ok) {
    log('warn', `${wc.reason}. Mode B is unavailable; falling back to Mode A (<video> → Canvas).`);
    el.renderer.value = 'video';
  }
  checkServer();
})();

function checkServer(): void {
  const base = getApiBase() || location.origin;
  el.apiBase.value = getApiBase();
  api
    .health()
    .then((h) => {
      el.apiStatus.textContent = `API: ${base} ✔ (node ${h.node}, yt-dlp ${h.ytdlp.available ? h.ytdlp.version : 'n/a'})`;
      log('info', `server ok at ${base} (node ${h.node}); yt-dlp ${h.ytdlp.available ? h.ytdlp.version + ' via ' + h.ytdlp.command : 'unavailable'}; resolver=${h.resolver}`);
    })
    .catch((e) => {
      el.apiStatus.textContent = `API: ${base} ✖ unreachable`;
      log('warn', `resolver server not reachable at ${base}/api (${(e as Error).message}). TikTok needs the server; Test MP4 / local file modes still work. Set the API base URL above (e.g. your Render URL).`);
    });
}
el.apiBase.addEventListener('change', () => {
  setApiBase(el.apiBase.value);
  checkServer();
});

function updateSourceVisibility(): void {
  const mode = el.source.value as SourceMode;
  el.testWrap.classList.toggle('hidden', mode !== 'test');
  el.localWrap.classList.toggle('hidden', mode !== 'local');
  el.formatWrap.classList.toggle('hidden', !(state.resolved && state.resolved.source === 'tiktok' && (mode === 'auto' || mode === 'direct' || mode === 'proxy')));
}
el.source.addEventListener('change', updateSourceVisibility);
el.load.addEventListener('click', () => pressed(el.load, () => loadVideo(), { label: 'Loading' }));
el.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pressed(el.load, () => loadVideo(), { label: 'Loading' });
});
el.format.addEventListener('change', () => {
  if (state.resolved) void loadVideo(true);
});
el.clearLog.addEventListener('click', clearLog);

// ---------- renderer management ----------
const events: RendererEvents = {
  onStateChange: (s) => {
    el.playPause.textContent = s === 'playing' || s === 'buffering' ? '❚❚' : '▶';
    el.playPause.disabled = s === 'idle' || s === 'loading' || s === 'error';
    el.seek.disabled = s === 'idle' || s === 'loading' || s === 'error' || state.rendererKind === 'embed';
    if (s === 'buffering') setOverlay('Buffering…');
    else if (s === 'loading') setOverlay('Loading…');
    else if (s === 'ended') setOverlay('Ended – press play to restart');
    else if (s !== 'error') setOverlay('');
    log('info', `[${state.renderer?.name}] state → ${s}`);
  },
  onLog: (level, msg) => log(level, msg),
  onFirstFrame: () => {
    setOverlay('');
    report(true, 'first frame rendered');
  },
  onError: (err) => {
    setOverlay(`Error: ${err.message}`, true);
    report(false, err.message);
  },
};

function report(ok: boolean, detail: string): void {
  if (state.reported || !state.current) return;
  state.reported = true;
  void api.report({ mediaId: state.current.mediaId, url: state.current.url.slice(0, 200), connection: state.current.connection, renderer: state.renderer?.name || '?', ok, detail });
}

function makeRenderer(kind: RendererKind): Renderer {
  state.renderer?.destroy();
  el.canvas.classList.toggle('hidden', kind === 'embed');
  state.rendererKind = kind;
  if (kind === 'webcodecs') return new WebCodecsRenderer(el.canvas, events);
  if (kind === 'video') return new VideoElementRenderer(el.canvas, el.stage, events);
  return new EmbedRenderer(el.stage, events);
}

// ---------- loading ----------
function selectedFormat(resolved: ResolveResponse): MediaFormat {
  const id = el.format.value;
  return resolved.formats.find((f) => f.id === id) || resolved.formats.find((f) => f.codec === 'h264') || resolved.formats[0];
}

function fillFormats(resolved: ResolveResponse): void {
  const prev = el.format.value;
  el.format.innerHTML = '';
  for (const f of resolved.formats) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = `${f.label}${f.directUrl ? ' · direct candidate' : ' · proxy only'}`;
    el.format.appendChild(o);
  }
  const def = resolved.formats.find((f) => f.id === prev) || resolved.formats.find((f) => f.codec === 'h264') || resolved.formats[0];
  if (def) el.format.value = def.id;
}

function showResolveInfo(r: ResolveResponse, f: MediaFormat): void {
  const lines: string[] = [];
  lines.push(`<b>${r.source === 'tiktok' ? 'TikTok' : 'MP4'}</b> resolved by <b>${r.resolver}</b> in ${r.elapsedMs} ms${r.author ? ` · @${r.author}` : ''}${r.duration ? ` · ${r.duration}s` : ''}${r.width ? ` · ${r.width}×${r.height}` : ''}`);
  if (r.title) lines.push(`“${r.title.slice(0, 140)}”`);
  lines.push(`Format <b>${f.label}</b> → direct: ${f.directUrl ? `${f.directKind} (${new URL(f.directUrl).hostname})` : 'none'} · proxy: ${f.proxyUrl ? 'available' : 'none'}${f.expiresAt ? ` · URL expires ${new Date(f.expiresAt * 1000).toLocaleString()}` : ''}`);
  if (f.serverProbe) {
    const p = f.serverProbe;
    lines.push(`Server probe of direct URL: HTTP ${p.status}, ACAO=${p.headers.accessControlAllowOrigin ?? 'none'}, Accept-Ranges=${p.headers.acceptRanges ?? 'none'}, Content-Type=${p.headers.contentType ?? '?'}${p.error ? ', error: ' + p.error : ''}`);
  }
  for (const w of r.warnings) lines.push(`<span class="warn">⚠ ${w}</span>`);
  el.resolveInfo.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  el.resolveInfo.classList.remove('hidden');
}

async function loadVideo(reuseResolved = false): Promise<void> {
  const mode = el.source.value as SourceMode;
  const rendererKind = el.renderer.value as RendererKind;
  state.reported = false;
  setOverlay('Loading…');
  try {
    let src: LoadSource | undefined;
    if (mode === 'test') {
      const url = el.test.value;
      const t = await testFetch(url);
      log('info', `browser CORS test for test MP4: ${t.ok ? 'passed' : 'FAILED: ' + t.error} (${t.elapsedMs.toFixed(0)} ms)`);
      src = { url, label: `Test MP4: ${new URL(url).pathname.split('/').pop()}`, connection: 'test', sourceKind: 'mp4', fetchInit: { mode: 'cors', credentials: 'same-origin' }, corsResult: t.ok ? 'passed' : 'failed', corsDetail: t.error };
    } else if (mode === 'local') {
      const file = el.file.files?.[0];
      if (!file) throw new Error('Choose a local file first');
      if (state.localUrl) URL.revokeObjectURL(state.localUrl);
      state.localUrl = URL.createObjectURL(file);
      src = { url: state.localUrl, label: `Local file: ${file.name} (${formatBytes(file.size)})`, connection: 'local', sourceKind: 'local', corsResult: 'same-origin' };
    } else {
      const url = el.url.value.trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Enter an http(s) URL');
      let resolved = reuseResolved && state.resolved && state.resolved.inputUrl === url ? state.resolved : undefined;
      if (!resolved) {
        log('info', `resolving ${url} …`);
        resolved = await api.resolve({ url, origin: location.origin });
        state.resolved = resolved;
        if (resolved.source === 'tiktok') state.lastTikTok = resolved;
        fillFormats(resolved);
        updateSourceVisibility();
        log('info', `resolved via ${resolved.resolver}: ${resolved.formats.length} format(s) [${resolved.formats.map((f) => `${f.id}:${f.codec}${f.directUrl ? '/direct' : ''}`).join(', ')}]${resolved.warnings.length ? ' warnings: ' + resolved.warnings.join(' | ') : ''}`);
      }
      const f = selectedFormat(resolved);
      showResolveInfo(resolved, f);
      if (rendererKind === 'embed') {
        // The official iframe never touches our media URLs; skip connection selection.
        src = { url: resolved.canonicalUrl || url, label: `TikTok ${resolved.id} (official player)`, connection: 'embed', sourceKind: resolved.source, videoId: resolved.source === 'tiktok' ? resolved.id : undefined };
      } else {
        src = await chooseConnection(resolved, f, mode);
      }
    }
    if (rendererKind === 'embed' && !src.videoId) {
      const m = /\/video\/(\d+)/.exec(el.url.value);
      src.videoId = m?.[1];
    }
    state.current = src;
    state.renderer = makeRenderer(rendererKind);
    log('info', `loading with ${state.renderer.name}: ${src.label} [${src.connection}]${src.corsDetail ? ' (' + src.corsDetail + ')' : ''}`);
    el.seek.value = '0';
    await state.renderer.load(src);
    if (rendererKind !== 'embed') await state.renderer.play();
  } catch (e) {
    const err = e as Error;
    const msg = err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : err.message;
    log('error', msg);
    setOverlay(`Error: ${msg}`, true);
    report(false, msg);
  } finally {
  }
}

/** Decide between direct and proxy delivery by actually testing fetch() access from this browser. */
async function chooseConnection(resolved: ResolveResponse, f: MediaFormat, mode: SourceMode): Promise<LoadSource> {
  const label = resolved.source === 'tiktok' ? `TikTok ${resolved.id} ${f.id}` : `MP4 ${new URL(resolved.inputUrl).hostname}`;
  const base: Omit<LoadSource, 'url' | 'connection'> = { label, sourceKind: resolved.source, mediaId: f.mediaId };
  const failures: string[] = [];
  if (mode === 'auto' || mode === 'direct') {
    // Candidate order: the cookie-free redirect URL first, because the browser then resolves the CDN
    // location itself (its own IP/region) – important when the resolver runs on a hosted server with a
    // datacenter IP. The server-resolved CDN URL is the second candidate.
    const candidates: { url: string; kind: string }[] = [];
    if (f.redirectUrl) candidates.push({ url: f.redirectUrl, kind: 'redirect' });
    if (f.directUrl && f.directUrl !== f.redirectUrl) candidates.push({ url: f.directUrl, kind: f.directKind || 'direct' });
    if (!candidates.length) failures.push('resolver found no cookie-free URL for this format');
    for (const c of candidates) {
      const t = await testFetch(c.url, { mode: 'cors', credentials: 'same-origin' });
      log(t.ok ? 'info' : 'warn', `browser fetch() test [${c.kind}] ${new URL(c.url).hostname}: ${t.ok ? `passed (HTTP ${t.status}, ${t.bytes} bytes, ${t.elapsedMs.toFixed(0)} ms)` : `failed: ${t.error}`}`);
      if (t.ok) {
        return { ...base, url: c.url, connection: 'direct', fetchInit: { mode: 'cors', credentials: 'same-origin' }, corsResult: 'passed', corsDetail: `${c.kind}: HTTP ${t.status}` };
      }
      failures.push(`${c.kind} (${new URL(c.url).hostname}): ${t.error}`);
    }
    if (mode === 'direct') {
      throw new Error(`Direct CDN access failed. ${failures.join('; ')}. ${f.serverProbe ? `Server saw HTTP ${f.serverProbe.status} with Access-Control-Allow-Origin=${f.serverProbe.headers.accessControlAllowOrigin ?? 'none'}.` : ''} Switch Source to "Proxy only" or "Auto".`);
    }
  }
  if (!f.proxyUrl) throw new Error(`No proxy available for this format (${failures.join('; ') || 'upstream host not allowlisted'})`);
  const proxyUrl = apiUrl(f.proxyUrl);
  const crossOrigin = Boolean(getApiBase());
  const t = await testFetch(proxyUrl, { mode: 'cors', credentials: 'same-origin' });
  log(t.ok ? 'info' : 'error', `proxy test ${proxyUrl}: ${t.ok ? `passed (HTTP ${t.status})` : `failed: ${t.error}`}`);
  if (!t.ok) throw new Error(`Proxy request failed: ${t.error}`);
  if (failures.length) log('warn', `falling back to proxy because direct access failed: ${failures.join('; ')}`);
  return { ...base, url: proxyUrl, connection: 'proxy', fetchInit: { mode: 'cors', credentials: 'same-origin' }, corsResult: crossOrigin ? 'passed' : 'same-origin', corsDetail: failures.length ? `direct failed: ${failures.join('; ')}` : 'proxy selected explicitly' };
}

// ---------- controls ----------
el.playPause.addEventListener('click', () => {
  const r = state.renderer;
  if (!r) return;
  if (r.state === 'playing' || r.state === 'buffering') r.pause();
  else void r.play();
});
el.seek.addEventListener('input', () => {
  state.seeking = true;
  const r = state.renderer;
  if (r) el.timeNow.textContent = formatTime((Number(el.seek.value) / 1000) * r.duration);
});
el.seek.addEventListener('change', () => {
  state.seeking = false;
  const r = state.renderer;
  if (!r || !r.duration) return;
  r.seek((Number(el.seek.value) / 1000) * r.duration);
});
el.volume.addEventListener('input', () => state.renderer?.setVolume(Number(el.volume.value)));
el.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.stage.requestFullscreen();
});
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    el.playPause.click();
  } else if (e.key === 'ArrowRight' && state.renderer) state.renderer.seek(Math.min(state.renderer.duration, state.renderer.currentTime + 5));
  else if (e.key === 'ArrowLeft' && state.renderer) state.renderer.seek(Math.max(0, state.renderer.currentTime - 5));
});

// ---------- stats ----------
function renderStats(s: PlayerStats): void {
  const rows: [string, string, string?][] = [
    ['Source', s.source],
    ['Resolution', s.resolution],
    ['Video codec', s.videoCodec],
    ['Renderer', s.renderer],
    ['Audio', s.audio],
    ['Connection', s.connection === 'direct' ? 'Direct CDN' : s.connection === 'proxy' ? 'Proxy' : s.connection === 'test' ? 'Direct (test MP4)' : s.connection === 'local' ? 'Local file' : s.connection === 'embed' ? 'Embed (iframe)' : '-'],
    ['FPS', String(s.fps)],
    ['Dropped frames', String(s.droppedFrames), s.droppedFrames ? 'warn' : 'ok'],
    ['Decoded / rendered', `${s.decodedFrames} / ${s.renderedFrames}`],
    ['Decoder queue / frames buffered', `${s.decodeQueue} / ${s.framesBuffered}`],
    ['Buffer ahead', `${s.bufferedAheadSec.toFixed(2)} s`],
    ['Downloaded', s.totalBytes ? `${formatBytes(s.bytesLoaded)} / ${formatBytes(s.totalBytes)} (${((100 * s.bytesLoaded) / s.totalBytes).toFixed(0)}%)` : formatBytes(s.bytesLoaded)],
    ['CORS', s.cors, s.cors.startsWith('Passed') ? 'ok' : s.cors.startsWith('Failed') ? 'bad' : undefined],
    ['State', s.state, s.state === 'error' ? 'bad' : undefined],
  ];
  for (const [k, v] of Object.entries(s.extra)) rows.push([k, v]);
  el.stats.innerHTML = rows.map(([k, v, cls]) => `<div><span>${k}</span><span class="${cls || ''}">${escapeHtml(v)}</span></div>`).join('');
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
setInterval(() => {
  const r = state.renderer;
  if (!r) return;
  const s = r.stats();
  renderStats(s);
  const dur = r.duration;
  el.timeTotal.textContent = formatTime(dur);
  if (!state.seeking) {
    el.timeNow.textContent = formatTime(r.currentTime);
    el.seek.value = dur ? String(Math.round((1000 * r.currentTime) / dur)) : '0';
  }
}, 250);

// ---------- experiments ----------
function renderResults(results: ExperimentResult[]): void {
  const tbody = el.results.tBodies[0];
  tbody.innerHTML = '';
  for (const r of results) {
    const tr = document.createElement('tr');
    const label = r.status === 'pass' ? '✔ PASS' : r.status === 'fail' ? '✖ FAIL' : r.status === 'skip' ? '– SKIP' : r.status === 'running' ? '… running' : 'pending';
    tr.innerHTML = `<td>${escapeHtml(r.name)}</td><td class="details">${escapeHtml(r.expected)}</td><td class="result ${r.status}">${label}<br><span class="muted">${escapeHtml(r.summary)}</span></td><td class="details">${escapeHtml(r.details)}</td>`;
    tbody.appendChild(tr);
  }
}
renderResults(state.results);

el.runTests.addEventListener('click', () => pressed(el.runTests, runAllExperiments, { label: 'Running experiments' }));
async function runAllExperiments(): Promise<void> {
  try {
    state.results = await runExperiments(
      {
        testUrl: el.test.value,
        log,
        getTikTok: async () => {
          if (state.lastTikTok) return state.lastTikTok;
          const url = el.url.value.trim();
          if (!/tiktok\.com/i.test(url)) return undefined;
          const r = await api.resolve({ url, origin: location.origin });
          if (r.source === 'tiktok') state.lastTikTok = r;
          return r;
        },
      },
      renderResults,
    );
    renderResults(state.results);
    log('info', `experiments finished: ${state.results.map((r) => `${r.id}=${r.status}`).join(', ')}`);
  } catch (e) {
    log('error', `experiments crashed: ${(e as Error).message}`);
  }
}
el.copyResults.addEventListener('click', () =>
  pressed(
    el.copyResults,
    async () => {
      const payload = { userAgent: navigator.userAgent, at: new Date().toISOString(), results: state.results };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        log('info', 'results copied to clipboard');
      } catch (e) {
        log('warn', `clipboard write failed: ${(e as Error).message}`);
      }
    },
    { label: 'Copying' },
  ),
);

// Expose for console poking
(window as unknown as { streamAnywhere: unknown }).streamAnywhere = state;
