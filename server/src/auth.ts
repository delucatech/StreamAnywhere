/**
 * Site password: every page and API call needs the `sa_auth` cookie, which POST /login sets after
 * the right password. The cookie is an HMAC-signed issue time (no server-side state), so it survives
 * restarts; it is valid for a year and renewed while the site is used. Changing the password
 * (APP_PASSWORD_HASH) invalidates every cookie.
 *
 * The repository is public, so only a salted scrypt hash of the password is stored here. New hash:
 *   node -e "const c=require('crypto'),s=c.randomBytes(16);console.log('scrypt:'+s.toString('hex')+':'+c.scryptSync(process.argv[1],s,32).toString('hex'))" "<password>"
 * APP_PASSWORD_HASH=off turns the password off (local experiments only).
 *
 * The cookie is signed with a SECRET key, never with the (public) hash alone: APP_COOKIE_SECRET, or a
 * random key generated on first start and kept in a 0600 file next to the TikTok profile directory
 * (APP_COOKIE_SECRET_FILE overrides the path), so cookies survive restarts and redeploys. The password
 * hash is mixed into the key as well, so a new password still signs every browser out.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const DEFAULT_HASH = 'scrypt:eb3fc89f8fc253c2e01a4a85d7c3530d:268de6a1156ad761dedda11285beb7e24f97f2edf61467cedb0d6cecb8fcd49c';
const COOKIE = 'sa_auth';
const MAX_AGE_SEC = 365 * 24 * 3600;
const RENEW_AFTER_SEC = 7 * 24 * 3600;
/** Reachable without the cookie: the login page itself and the deploy health check. */
const PUBLIC_PATHS = new Set(['/login', '/api/health']);

/** Set by registerAuth (read then, not at import, so tests can supply their own hash). */
let passwordHash = DEFAULT_HASH;
let cookieKey: Buffer = Buffer.alloc(0);

function secretFilePath(): string {
  if (process.env.APP_COOKIE_SECRET_FILE) return process.env.APP_COOKIE_SECRET_FILE;
  const dir = process.env.TIKTOK_PROFILE_DIR ? path.dirname(process.env.TIKTOK_PROFILE_DIR) : path.join(os.homedir(), '.streamanywhere');
  return path.join(dir, 'cookie-secret');
}

/** The cookie-signing secret: the environment, else the persisted random key (created on first start). */
function loadCookieSecret(warn: (m: string) => void): Buffer {
  const env = (process.env.APP_COOKIE_SECRET || '').trim();
  if (env) return Buffer.from(env, 'utf8');
  const file = secretFilePath();
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
    warn(`cookie secret file ${file} is not a 64-hex-digit key; replacing it`);
  } catch {
    /* none yet */
  }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh.toString('hex') + '\n', { mode: 0o600 });
  } catch (e) {
    warn(`cookie secret could not be saved to ${file} (${(e as Error).message}): login cookies will not survive a restart`);
  }
  return fresh;
}

function sign(issued: number): string {
  return crypto.createHmac('sha256', cookieKey).update(`sa1.${issued}`).digest('base64url');
}

function makeToken(): string {
  const issued = Math.floor(Date.now() / 1000);
  return `${issued}.${sign(issued)}`;
}

/** Issue time of a valid token, or undefined. */
function tokenIssued(token: string | undefined): number | undefined {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  if (!m) return undefined;
  const issued = Number(m[1]);
  const age = Date.now() / 1000 - issued;
  if (age < -300 || age > MAX_AGE_SEC) return undefined;
  const a = Buffer.from(m[2]);
  const b = Buffer.from(sign(issued));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? issued : undefined;
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function setAuthCookie(req: FastifyRequest, reply: FastifyReply): void {
  // Behind Caddy the request arrives as http with X-Forwarded-Proto: https
  const https = req.protocol === 'https' || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
  reply.header('set-cookie', `${COOKIE}=${makeToken()}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
}

async function passwordMatches(input: string): Promise<boolean> {
  const [kind, saltHex, hashHex] = passwordHash.split(':');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(input, Buffer.from(saltHex, 'hex'), expected.length, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return crypto.timingSafeEqual(got, expected);
}

/**
 * Only same-site paths: no "//host" or "/\host" open redirects. Browsers strip tabs and newlines
 * before parsing a URL ("/\t/evil.example" becomes "//evil.example"), so control characters are
 * refused and the WHATWG parser has the final say on where the path would lead.
 */
function safeNext(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  if (!/^\/(?![/\\])/.test(s) || /[\x00-\x20\x7f]/.test(s)) return '/';
  try {
    const u = new URL(s, 'http://x');
    return u.origin === 'http://x' ? u.pathname + u.search : '/';
  } catch {
    return '/';
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(next: string, wrong: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StreamAnywhere</title>
<style>
:root{color-scheme:dark light;--bg:#111;--fg:#eee;--muted:#999;--card:#1c1c1c;--line:#333;--accent:#fe2c55}
@media (prefers-color-scheme:light){:root{--bg:#f4f4f4;--fg:#111;--muted:#666;--card:#fff;--line:#ccc}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
form{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:var(--muted)}
input,button{width:100%;font:inherit;padding:12px;border-radius:8px}
input{border:1px solid var(--line);background:var(--bg);color:var(--fg);margin-bottom:12px}
button{border:0;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
.err{color:var(--accent);margin:0 0 12px}
</style></head>
<body><form method="post" action="/login">
<h1>StreamAnywhere</h1><p>Enter the password to continue.</p>
${wrong ? '<p class="err">Wrong password.</p>' : ''}
<input type="password" name="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Continue</button>
</form></body></html>`;
}

export function registerAuth(app: FastifyInstance): void {
  passwordHash = (process.env.APP_PASSWORD_HASH || DEFAULT_HASH).trim();
  if (/^(off|none|0|false)$/i.test(passwordHash)) {
    app.log.warn('APP_PASSWORD_HASH=off: the site is open to anyone');
    return;
  }
  // Key = HMAC(secret, hash): unknowable without the secret, and different for every password.
  const secret = loadCookieSecret((m) => app.log.warn(m));
  cookieKey = crypto.createHmac('sha256', secret).update('streamanywhere-cookie|' + passwordHash).digest();

  // The login form posts application/x-www-form-urlencoded (works without JavaScript)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (PUBLIC_PATHS.has(p) || req.method === 'OPTIONS') return;
    const issued = tokenIssued(readCookie(req, COOKIE));
    if (issued !== undefined) {
      if (Date.now() / 1000 - issued > RENEW_AFTER_SEC) setAuthCookie(req, reply);
      return;
    }
    if (p.startsWith('/api/')) return reply.code(401).send({ error: 'Password required: open the site and sign in', login: '/login' });
    if (req.method === 'GET' || req.method === 'HEAD') return reply.redirect('/login?next=' + encodeURIComponent(req.url), 303);
    return reply.code(401).send({ error: 'Password required' });
  });

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    const next = safeNext(req.query.next);
    if (tokenIssued(readCookie(req, COOKIE)) !== undefined) return reply.redirect(next, 303);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(loginPage(next, false));
  });

  app.post<{ Body: { password?: string; next?: string } }>(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const next = safeNext(req.body?.next);
      if (await passwordMatches(String(req.body?.password || ''))) {
        req.log.info('site password accepted');
        setAuthCookie(req, reply);
        return reply.redirect(next, 303);
      }
      req.log.warn('wrong site password');
      return reply.code(401).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(loginPage(next, true));
    },
  );
}
