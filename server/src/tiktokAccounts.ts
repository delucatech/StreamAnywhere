/**
 * Several TikTok sign-ins on one server, one of them active.
 *
 * A TikTok sign-in is a private browser profile (session.ts). Until 2026-11-25 there was exactly
 * one, in TIKTOK_PROFILE_DIR. That folder is still the "main" account and is never moved, renamed
 * or deleted by anything in this file: every other account gets a folder of its own under
 * `tiktok-accounts/<id>/` beside it, and a small index says which account is the active one.
 *
 *   <dir>/tiktok-profile/              the main account's browser profile (as before)
 *   <dir>/tiktok-accounts.json         { active, accounts: [{ id, label, username, ... }] }
 *   <dir>/tiktok-accounts/<id>/profile another account's browser profile
 *
 * Only one account's browser runs at a time (the 1 GB server could not hold two): switching closes
 * the browser and points it at the other profile (session.ts switchTikTokAccount). Removing an
 * account deletes its folder; the main one cannot be removed here ("Sign out" empties it, as before).
 *
 * Also here: reading the cookies someone pastes to sign an account in without the QR code
 * (a cookies.txt export, a cookie extension's JSON, or a Cookie: header).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fromHeader, fromJson, fromNetscape, type ParsedCookie } from './youtubeSession';

export const MAIN_ACCOUNT = 'main';

export class TikTokAccountError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export interface AccountRecord {
  id: string;
  /** What the user called it ("Spare"); the handle is shown when there is none */
  label?: string;
  /** Who it was the last time it was seen signed in */
  username?: string;
  nickname?: string;
  avatar?: string;
  addedAt: number;
  /** How it was last signed in */
  via?: 'browser' | 'cookies';
}

interface Store {
  active: string;
  accounts: AccountRecord[];
}

let mainProfile = process.env.TIKTOK_PROFILE_DIR || path.join(os.homedir(), '.streamanywhere', 'tiktok-profile');
let store: Store | undefined;

const root = (): string => path.dirname(mainProfile);
const storeFile = (): string => path.join(root(), 'tiktok-accounts.json');
const accountsDir = (): string => path.join(root(), 'tiktok-accounts');
const validId = (id: string): boolean => /^[a-z0-9]{6,16}$/.test(id);

/** Tests: another place for the main profile (and with it the index and the other accounts). */
export function configureTikTokAccounts(mainProfileDir: string): void {
  mainProfile = mainProfileDir;
  store = undefined;
}

function load(): Store {
  if (store) return store;
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    /* no index yet: one account, the main one */
  }
  const accounts: AccountRecord[] = [];
  for (const a of Array.isArray(raw?.accounts) ? raw.accounts : []) {
    if (!a || typeof a.id !== 'string' || accounts.some((x) => x.id === a.id)) continue;
    if (a.id !== MAIN_ACCOUNT && !validId(a.id)) continue;
    accounts.push({
      id: a.id,
      label: typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 40) : undefined,
      username: typeof a.username === 'string' ? a.username : undefined,
      nickname: typeof a.nickname === 'string' ? a.nickname : undefined,
      avatar: typeof a.avatar === 'string' ? a.avatar : undefined,
      addedAt: Number(a.addedAt) || 0,
      via: a.via === 'cookies' ? 'cookies' : a.via === 'browser' ? 'browser' : undefined,
    });
  }
  if (!accounts.some((a) => a.id === MAIN_ACCOUNT)) accounts.unshift({ id: MAIN_ACCOUNT, addedAt: 0 });
  const active = typeof raw?.active === 'string' && accounts.some((a) => a.id === raw.active) ? raw.active : MAIN_ACCOUNT;
  store = { active, accounts };
  return store;
}

function save(): void {
  const s = load();
  fs.mkdirSync(root(), { recursive: true });
  const tmp = storeFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storeFile());
}

export const activeAccountId = (): string => load().active;
export const accountRecords = (): AccountRecord[] => load().accounts.map((a) => ({ ...a }));
export const accountRecord = (id: string): AccountRecord | undefined => accountRecords().find((a) => a.id === id);

/** The browser profile folder of an account: the main one's is TIKTOK_PROFILE_DIR itself. */
export function accountProfileDir(id: string): string {
  if (id === MAIN_ACCOUNT) return mainProfile;
  if (!validId(id)) throw new TikTokAccountError('That is not an account id');
  return path.join(accountsDir(), id, 'profile');
}
export const activeProfileDir = (): string => accountProfileDir(activeAccountId());

/** A new, empty account (not the active one yet). */
export function createAccount(label?: string): AccountRecord {
  const s = load();
  if (s.accounts.length >= 8) throw new TikTokAccountError('There are 8 accounts already; remove one first', 409);
  let id = '';
  do id = crypto.randomBytes(4).toString('hex');
  while (s.accounts.some((a) => a.id === id));
  const rec: AccountRecord = { id, label: label?.trim().slice(0, 40) || undefined, addedAt: Date.now() };
  s.accounts.push(rec);
  save();
  return { ...rec };
}

export function setActiveAccount(id: string): void {
  const s = load();
  if (!s.accounts.some((a) => a.id === id)) throw new TikTokAccountError('That account is not on this server', 404);
  if (s.active === id) return;
  s.active = id;
  save();
}

/** Who an account turned out to be, and how it was signed in (kept for the list while it is not the active one). */
export function rememberAccount(id: string, who: { username?: string; nickname?: string; avatar?: string; via?: 'browser' | 'cookies' }): void {
  const s = load();
  const rec = s.accounts.find((a) => a.id === id);
  if (!rec) return;
  const before = JSON.stringify(rec);
  if (who.username) rec.username = who.username;
  if (who.nickname) rec.nickname = who.nickname;
  if (who.avatar) rec.avatar = who.avatar;
  if (who.via) rec.via = who.via;
  if (JSON.stringify(rec) !== before) save();
}

/** The main account after "Sign out": the folder is emptied by session.ts; this forgets who it was. */
export function forgetAccountIdentity(id: string): void {
  const s = load();
  const rec = s.accounts.find((a) => a.id === id);
  if (!rec) return;
  rec.username = rec.nickname = rec.avatar = rec.via = undefined;
  save();
}

/**
 * Deletes an account and its folder. Never the main one, never the active one (switch away first),
 * and never anything outside `tiktok-accounts/`.
 */
export function removeAccount(id: string): void {
  const s = load();
  if (id === MAIN_ACCOUNT) throw new TikTokAccountError('The main account cannot be removed; "Sign out" ends its sign-in', 409);
  if (!validId(id) || !s.accounts.some((a) => a.id === id)) throw new TikTokAccountError('That account is not on this server', 404);
  if (s.active === id) throw new TikTokAccountError('Switch to another account before removing this one', 409);
  const dir = path.join(accountsDir(), id);
  const inside = path.relative(accountsDir(), dir);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new TikTokAccountError('That folder is not an account folder', 500);
  fs.rmSync(dir, { recursive: true, force: true });
  s.accounts = s.accounts.filter((a) => a.id !== id);
  save();
}

// ---------------------------------------------------------------- pasted cookies

/** The cookies that are a TikTok sign-in: without `sessionid` there is none. */
const SESSION_COOKIE = 'sessionid';
/**
 * Left out of an import: they describe the browser the cookies came from, not the account.
 * `tt_ticket_guard_has_set_public_key` tells TikTok's script "this browser already registered its
 * key" - true for the browser that exported the cookies, false for the one receiving them.
 */
const NOT_IMPORTED = new Set(['tt_ticket_guard_has_set_public_key', 'perf_feed_cache', 'last_visited_page', 'passport_fe_beating_status']);

/**
 * Text copied through a chat or a document often has its host names turned into links:
 * ".[www.tiktok.com](https://www.tiktok.com)" for ".www.tiktok.com". Undone before parsing.
 */
export const unlinkHosts = (text: string): string => text.replace(/\[((?:[\w-]+\.)+[a-z]{2,})\]\(https?:\/\/[^)\s]*\)/gi, '$1');

/**
 * Cookies out of whatever was pasted (a cookies.txt export, a cookie extension's JSON, a Cookie:
 * header), restricted to tiktok.com. Throws when nothing usable is in it or it carries no sign-in.
 */
export function parseTikTokCookies(text: string): { cookies: ParsedCookie[]; warnings: string[] } {
  const t = unlinkHosts((text || '').trim());
  if (!t) throw new TikTokAccountError('Paste the cookies first');
  if (t.length > 2_000_000) throw new TikTokAccountError('That is too much text for a cookies file', 413);
  let all = fromJson(t, '.tiktok.com') || fromNetscape(t);
  if (!all.length && /=/.test(t) && !/\t/.test(t)) all = fromHeader(t, '.tiktok.com');
  if (!all.length) throw new TikTokAccountError('No cookies found in that text. Expected a cookies.txt export (one cookie per line, tab-separated), a JSON export of a cookie extension, or a Cookie: header.');
  const warnings: string[] = [];
  const onTikTok = all.filter((c) => /(^|\.)tiktok\.com$/i.test(c.domain.replace(/^\./, '')));
  const other = all.length - onTikTok.length;
  if (other) warnings.push(`${other} cookie${other === 1 ? '' : 's'} of other sites ignored`);
  const kept = onTikTok.filter((c) => !NOT_IMPORTED.has(c.name) && c.value !== '');
  const session = kept.find((c) => c.name === SESSION_COOKIE);
  if (!session) throw new TikTokAccountError('These cookies carry no TikTok sign-in (no "sessionid" for tiktok.com). Export them from a browser where tiktok.com shows your account, while on tiktok.com.');
  if (session.expires && session.expires * 1000 < Date.now()) throw new TikTokAccountError('The sign-in in these cookies has run out (its "sessionid" expired). Sign in at tiktok.com again and export fresh cookies.');
  // One cookie per domain+path+name: a later line wins (exports list the newest last).
  const map = new Map<string, ParsedCookie>();
  for (const c of kept) map.set(`${c.domain.toLowerCase()}|${c.path}|${c.name}`, c);
  return { cookies: [...map.values()], warnings };
}

/** The cookies as the browser driver takes them (a cookie without an expiry stays a session cookie). */
export function toBrowserCookies(cookies: ParsedCookie[]): Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; expires?: number }> {
  return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly, ...(c.expires > 0 ? { expires: c.expires } : {}) }));
}
