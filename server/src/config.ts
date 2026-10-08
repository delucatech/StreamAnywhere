import * as fs from 'node:fs';
import * as path from 'node:path';

/** Walk up from a directory looking for a relative path; returns the first existing match. */
export function findUp(rel: string, from: string = __dirname): string | undefined {
  let dir = path.resolve(from);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function loadDotEnv(): void {
  // Minimal .env loader (no dependency): server/.env then repo-root .env, searched upward from
  // both the compiled file location and the working directory.
  const candidates = new Set<string>();
  for (const start of [__dirname, process.cwd()]) {
    for (const rel of ['server/.env', '.env']) {
      const found = findUp(rel, start);
      if (found) candidates.add(found);
    }
  }
  for (const candidate of candidates) {
    for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadDotEnv();

const list = (v: string | undefined): string[] =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Hosts the proxy is always allowed to relay from (TikTok CDN + the bundled test MP4 hosts). */
export const BUILTIN_PROXY_HOSTS = [
  '*.tiktok.com',
  '*.tiktokcdn.com',
  '*.tiktokcdn-us.com',
  '*.tiktokcdn-eu.com',
  '*.tiktokv.com',
  '*.byteoversea.com',
  '*.ibyteimg.com',
  'mdn.github.io',
  'interactive-examples.mdn.mozilla.net',
];

const serveClient = /^(1|true|yes)$/i.test(process.env.SERVE_CLIENT || '');
const hosted = Boolean(process.env.RENDER || process.env.KOYEB_APP_NAME || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');

/** `--port N` on the command line beats PORT (handy for a second dev instance next to the default one). */
const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
})();

export const config = {
  port: argPort || Number(process.env.PORT || 8787),
  /** Bind loopback for local dev; all interfaces when serving the built client or on a hosting platform. */
  host: process.env.HOST || (serveClient || hosted ? '0.0.0.0' : '127.0.0.1'),
  hosted,
  clientOrigins: list(process.env.CLIENT_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'),
  proxyAllowedHosts: [...BUILTIN_PROXY_HOSTS, ...list(process.env.PROXY_ALLOWED_HOSTS)],
  resolver: (process.env.RESOLVER || 'auto') as 'auto' | 'native' | 'ytdlp',
  ytdlpPath: process.env.YTDLP_PATH || '',
  serveClient,
  /** Per-IP request limits for the public endpoints (per minute). */
  rateLimit: {
    resolvePerMinute: Number(process.env.RATE_LIMIT_RESOLVE || 20),
    mediaPerMinute: Number(process.env.RATE_LIMIT_MEDIA || 120),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  userAgent:
    process.env.UPSTREAM_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  /** Media registry entries expire after this many ms if the upstream URL has no explicit expiry */
  mediaTtlMs: 6 * 60 * 60 * 1000,
  upstreamTimeoutMs: 20_000,
};
