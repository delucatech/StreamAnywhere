/**
 * Video Downloader: paste a link, see the qualities on offer, download one as a file.
 *
 *  1. POST /api/download/probe looks the link up (yt-dlp) and lists the qualities: one per
 *     resolution (merged with the best audio) and "audio only".
 *  2. POST /api/download/start begins a server-side job for the chosen one; this page polls
 *     GET /api/download/jobs/:id every second and shows the progress.
 *  3. Done: the file is fetched from /api/download/jobs/:id/file (the browser's own download,
 *     with the video's title as the file name). The server keeps it for a while, so "Save file"
 *     can be tapped again.
 *
 * Sources: YouTube now; the others are shown as "soon" (the server says which are on).
 */
import type { DownloadJob, DownloadOption, DownloadProbeResponse, DownloadSource } from '../../../shared/types';
import { api, ApiError, apiUrl } from '../api';
import { PLATFORMS, rememberApp } from '../platforms';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
};
const el = {
  splash: $('splash'),
  titleIcon: $('titleIcon'),
  homeLink: $<HTMLAnchorElement>('homeLink'),
  sources: $('sources'),
  form: $<HTMLFormElement>('urlForm'),
  url: $<HTMLInputElement>('url'),
  pasteBtn: $<HTMLButtonElement>('pasteBtn'),
  lookupBtn: $<HTMLButtonElement>('lookupBtn'),
  hint: $('hint'),
  status: $('status'),
  video: $('video'),
  cover: $<HTMLImageElement>('cover'),
  vTitle: $('vTitle'),
  vSub: $('vSub'),
  optionsWrap: $('optionsWrap'),
  options: $('options'),
  downloadBtn: $<HTMLButtonElement>('downloadBtn'),
  job: $('job'),
  barFill: $('barFill'),
  jobText: $('jobText'),
  saveLink: $<HTMLAnchorElement>('saveLink'),
  cancelBtn: $<HTMLButtonElement>('cancelBtn'),
  againBtn: $<HTMLButtonElement>('againBtn'),
  foot: $('foot'),
};

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 2.5a1.2 1.2 0 0 1 1.2 1.2v8.3l2.6-2.6a1.2 1.2 0 0 1 1.7 1.7l-4.65 4.65a1.2 1.2 0 0 1-1.7 0L6.5 11.1a1.2 1.2 0 1 1 1.7-1.7l2.6 2.6V3.7A1.2 1.2 0 0 1 12 2.5z"/><path fill="#fff" opacity=".9" d="M4.5 14.3a1.2 1.2 0 0 1 1.2 1.2v2.9h12.6v-2.9a1.2 1.2 0 1 1 2.4 0v4.1a1.2 1.2 0 0 1-1.2 1.2H4.5a1.2 1.2 0 0 1-1.2-1.2v-4.1a1.2 1.2 0 0 1 1.2-1.2z"/></svg>';
el.titleIcon.innerHTML = ICON;

// ---------- sources ----------
interface SourceDef {
  id: DownloadSource;
  name: string;
  enabled: boolean;
}
const FALLBACK_SOURCES: SourceDef[] = [
  { id: 'youtube', name: 'YouTube', enabled: true },
  { id: 'tiktok', name: 'TikTok', enabled: false },
  { id: 'instagram', name: 'Instagram', enabled: false },
  { id: 'facebook', name: 'Facebook', enabled: false },
];
let sources: SourceDef[] = FALLBACK_SOURCES;
let source: DownloadSource = 'youtube';

function renderSources(): void {
  el.sources.textContent = '';
  for (const s of sources) {
    const p = PLATFORMS.find((x) => x.id === s.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `source${s.id === source ? ' on' : ''}${s.enabled ? '' : ' soon'}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s.id === source));
    b.disabled = !s.enabled;
    b.innerHTML = `<span class="dot" style="background:${p?.tile || '#444'}">${p?.icon || ''}</span>${s.name}${s.enabled ? '' : ' <small>soon</small>'}`;
    b.addEventListener('click', () => {
      if (!s.enabled) return;
      source = s.id;
      el.url.placeholder = `Paste a ${s.name} link`;
      renderSources();
      el.url.focus();
    });
    el.sources.appendChild(b);
  }
}
renderSources();

// ---------- helpers ----------
const fmtBytes = (n: number): string => (n >= 1024 * 1024 * 1024 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1024 * 1024 ? `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDuration = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtEta = (s: number): string => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

function setStatus(text: string, kind: 'busy' | 'error' | 'info' | 'none'): void {
  el.status.classList.toggle('hidden', kind === 'none');
  el.status.classList.toggle('error', kind === 'error');
  el.status.innerHTML = '';
  if (kind === 'busy') {
    const sp = document.createElement('span');
    sp.className = 'spinner';
    el.status.appendChild(sp);
  }
  el.status.appendChild(document.createTextNode(text));
}

// ---------- look-up ----------
let probe: DownloadProbeResponse | undefined;
let selected: DownloadOption | undefined;
let looking = false;

async function lookUp(raw: string): Promise<void> {
  const url = raw.trim();
  if (!url || looking) return;
  looking = true;
  resetJob();
  probe = undefined;
  el.video.classList.add('hidden');
  el.optionsWrap.classList.add('hidden');
  el.lookupBtn.disabled = true;
  setStatus('Looking the video up…', 'busy');
  try {
    probe = await api.downloadProbe(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    setStatus(msg, 'error');
    looking = false;
    el.lookupBtn.disabled = false;
    return;
  }
  looking = false;
  el.lookupBtn.disabled = false;
  setStatus('', 'none');
  if (probe.warnings.length) setStatus(probe.warnings.join(' '), 'info');
  renderVideo(probe);
  renderOptions(probe.options);
}

function renderVideo(p: DownloadProbeResponse): void {
  el.cover.src = p.cover ? apiUrl(p.cover) : '';
  el.cover.classList.toggle('hidden', !p.cover);
  el.cover.classList.remove('portrait');
  el.cover.onload = () => el.cover.classList.toggle('portrait', el.cover.naturalHeight > el.cover.naturalWidth);
  el.vTitle.textContent = p.title || p.url;
  const bits = [p.author, p.duration ? fmtDuration(p.duration) : '', sources.find((s) => s.id === p.source)?.name || p.source].filter(Boolean);
  el.vSub.textContent = bits.join(' · ');
  el.video.classList.remove('hidden');
}

function renderOptions(options: DownloadOption[]): void {
  el.options.textContent = '';
  selected = options.find((o) => o.recommended) || options[0];
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `option${o === selected ? ' on' : ''}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(o === selected));
    const size = o.sizeBytes ? `${o.sizeIsEstimate ? '~' : ''}${fmtBytes(o.sizeBytes)}` : '';
    b.innerHTML = `<span class="radio"></span><span class="q">${o.label}${o.recommended ? '<span class="rec">best fit</span>' : ''}<small>${o.detail}</small></span><span class="size">${size}</span>`;
    b.addEventListener('click', () => {
      selected = o;
      for (const x of el.options.children) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      }
      el.downloadBtn.textContent = `Download ${o.label}`;
    });
    el.options.appendChild(b);
  }
  el.downloadBtn.textContent = selected ? `Download ${selected.label}` : 'Download';
  el.downloadBtn.disabled = !selected;
  el.optionsWrap.classList.remove('hidden');
}

// ---------- the job ----------
let job: DownloadJob | undefined;
let pollTimer = 0;
let saved = false;

function resetJob(): void {
  window.clearTimeout(pollTimer);
  job = undefined;
  saved = false;
  el.job.classList.add('hidden');
  el.job.classList.remove('error');
  el.barFill.style.width = '0%';
  el.barFill.parentElement!.classList.remove('busy');
  el.saveLink.classList.add('hidden');
  el.cancelBtn.classList.add('hidden');
  el.againBtn.classList.add('hidden');
  el.downloadBtn.disabled = !selected;
}

async function startJob(): Promise<void> {
  if (!probe || !selected || job) return;
  el.downloadBtn.disabled = true;
  el.optionsWrap.classList.add('hidden');
  el.job.classList.remove('hidden');
  el.cancelBtn.classList.remove('hidden');
  el.jobText.textContent = 'Starting…';
  el.barFill.parentElement!.classList.add('busy');
  try {
    job = await api.downloadStart(probe.probeId, selected.id);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e as Error).message;
    if (e instanceof ApiError && e.status === 410) probe = undefined;
    showFailed(msg);
    return;
  }
  render(job);
  poll();
}

function poll(): void {
  window.clearTimeout(pollTimer);
  if (!job) return;
  pollTimer = window.setTimeout(async () => {
    if (!job) return;
    try {
      job = await api.downloadJob(job.jobId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return showFailed(e.message);
      // a blip: try again
      return poll();
    }
    render(job);
    if (job.state === 'queued' || job.state === 'downloading' || job.state === 'merging') poll();
  }, 1000);
}

function render(j: DownloadJob): void {
  const p = j.progress;
  const bar = el.barFill.parentElement!;
  el.job.classList.toggle('error', j.state === 'error' || j.state === 'cancelled');
  if (j.state === 'queued') {
    bar.classList.add('busy');
    el.jobText.textContent = j.queuePosition ? `Waiting for ${j.queuePosition} other download${j.queuePosition > 1 ? 's' : ''} to finish…` : 'Waiting for a turn…';
  } else if (j.state === 'downloading') {
    const known = p.percent !== undefined;
    bar.classList.toggle('busy', !known);
    if (known) el.barFill.style.width = `${p.percent}%`;
    const bits = [`Downloading${p.part ? ` the ${p.part}` : ''}`];
    if (known) bits.push(`${Math.round(p.percent!)}%`);
    bits.push(p.totalBytes ? `${fmtBytes(p.downloadedBytes)} of ${fmtBytes(p.totalBytes)}` : fmtBytes(p.downloadedBytes));
    if (p.speedBps) bits.push(`${fmtBytes(p.speedBps)}/s`);
    if (p.etaSec !== undefined && p.etaSec > 0) bits.push(`${fmtEta(p.etaSec)} left`);
    el.jobText.textContent = bits.join(' · ');
  } else if (j.state === 'merging') {
    bar.classList.add('busy');
    el.jobText.textContent = 'Merging video and audio…';
  } else if (j.state === 'done') {
    bar.classList.remove('busy');
    el.barFill.style.width = '100%';
    el.jobText.textContent = `Ready: ${j.fileName} (${fmtBytes(j.sizeBytes || 0)}). The download starts now; tap "Save file" if it did not.`;
    el.cancelBtn.classList.add('hidden');
    el.saveLink.href = apiUrl(j.fileUrl || '');
    el.saveLink.download = j.fileName || 'video.mp4';
    el.saveLink.classList.remove('hidden');
    el.againBtn.classList.remove('hidden');
    if (!saved) {
      saved = true;
      // the browser's own download: the server names the file (Content-Disposition)
      el.saveLink.click();
    }
  } else {
    showFailed(j.error || (j.state === 'cancelled' ? 'Cancelled' : 'The download failed'));
  }
}

function showFailed(msg: string): void {
  window.clearTimeout(pollTimer);
  el.job.classList.remove('hidden');
  el.job.classList.add('error');
  el.barFill.parentElement!.classList.remove('busy');
  el.barFill.style.width = '100%';
  el.jobText.textContent = msg;
  el.cancelBtn.classList.add('hidden');
  el.saveLink.classList.add('hidden');
  el.againBtn.classList.remove('hidden');
  el.againBtn.textContent = probe ? 'Try again' : 'Look the link up again';
  job = undefined;
}

el.cancelBtn.addEventListener('click', async () => {
  if (!job) return;
  el.cancelBtn.disabled = true;
  try {
    job = await api.downloadCancel(job.jobId);
    render(job);
  } catch {
    showFailed('Could not cancel');
  } finally {
    el.cancelBtn.disabled = false;
  }
});
el.againBtn.addEventListener('click', () => {
  el.againBtn.textContent = 'Download another';
  resetJob();
  if (probe) el.optionsWrap.classList.remove('hidden');
  else void lookUp(el.url.value);
});

// ---------- form ----------
el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  void lookUp(el.url.value);
});
el.downloadBtn.addEventListener('click', () => void startJob());
el.pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      el.url.value = text.trim();
      void lookUp(el.url.value);
      return;
    }
  } catch {
    /* no clipboard access: the field is focused for a manual paste */
  }
  el.url.focus();
});
// a link pasted into the field is looked up at once
el.url.addEventListener('paste', () => window.setTimeout(() => void lookUp(el.url.value), 0));

// ---------- home ----------
rememberApp('downloader');
let leaving = false;
el.homeLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (leaving) return;
  leaving = true;
  try {
    sessionStorage.setItem('streamanywhere.returnFrom', 'downloader');
  } catch {
    /* ignore */
  }
  location.assign(el.homeLink.href);
});

// ---------- start ----------
void api
  .downloadSources()
  .then((r) => {
    sources = r.sources;
    if (!sources.find((s) => s.id === source)?.enabled) source = sources.find((s) => s.enabled)?.id || source;
    renderSources();
    const foot: string[] = [];
    if (!r.ytdlp) foot.push('yt-dlp is not installed on the server: nothing can be looked up.');
    else if (!r.ffmpeg) foot.push('ffmpeg is not installed on the server: video and audio cannot be merged.');
    foot.push(`Files up to ${fmtBytes(r.maxBytes)}.`);
    el.foot.textContent = foot.join(' ');
  })
  .catch(() => undefined);

// ?url=… (a shared link) is looked up right away
try {
  const q = new URLSearchParams(location.search).get('url');
  if (q) {
    el.url.value = q;
    void lookUp(q);
  }
} catch {
  /* ignore */
}

// the launcher's splash fades out now that the page is set up
el.splash.classList.add('leaving');
window.setTimeout(() => el.splash.classList.add('hidden'), 350);
