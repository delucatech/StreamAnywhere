/**
 * Encryption at rest for Live TV: provider credentials (Xtream passwords, playlist URLs that embed
 * tokens) and the cached channel lists (whose stream URLs embed the same credentials) are stored
 * AES-256-GCM encrypted with a key the server generates on first use and keeps in a 0600 file
 * next to the cookie secret (LIVETV_KEY_FILE overrides the path, LIVETV_KEY the key itself, as
 * 64 hex digits). The same key makes the segment tokens the stream relay hands the browser
 * (livetvStream.ts): a token is the upstream URL encrypted, so the browser never sees it.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let key: Buffer | undefined;
let warn: (m: string) => void = () => undefined;
export const setLiveTvCryptoLogger = (fn: (m: string) => void): void => {
  warn = fn;
};

function keyFilePath(): string {
  if (process.env.LIVETV_KEY_FILE) return process.env.LIVETV_KEY_FILE;
  const dir = process.env.TIKTOK_PROFILE_DIR ? path.dirname(process.env.TIKTOK_PROFILE_DIR) : path.join(os.homedir(), '.streamanywhere');
  return path.join(dir, 'livetv-key');
}

function loadKey(): Buffer {
  if (key) return key;
  const env = (process.env.LIVETV_KEY || '').trim();
  if (/^[0-9a-f]{64}$/i.test(env)) return (key = Buffer.from(env, 'hex'));
  const file = keyFilePath();
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(text)) return (key = Buffer.from(text, 'hex'));
    warn(`${file} is not a 64-hex-digit key; replacing it (saved providers cannot be read any more)`);
  } catch {
    /* none yet */
  }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh.toString('hex') + '\n', { mode: 0o600 });
  } catch (e) {
    warn(`the Live TV key could not be saved to ${file} (${(e as Error).message}): saved providers will not survive a restart`);
  }
  return (key = fresh);
}

/** Tests: a throwaway key, nothing on disk. */
export function useEphemeralLiveTvKey(): void {
  key = crypto.randomBytes(32);
}

/**
 * "v1.<iv>.<tag>.<ciphertext>" (base64url). Deterministic tokens (the same URL gives the same
 * token, so a playlist that is reloaded every few seconds keeps its segment URLs) use an IV
 * derived from the plaintext with the key (a synthetic IV, as in AES-GCM-SIV); stored blobs use a
 * random one.
 */
export function encryptText(plain: string, deterministic = false): string {
  const k = loadKey();
  const iv = deterministic ? crypto.createHmac('sha256', k).update('iv|' + plain).digest().subarray(0, 12) : crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

/** The plaintext, or undefined when the blob is not ours (wrong key, tampered, malformed). */
export function decryptText(blob: string): string | undefined {
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return undefined;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(parts[1], 'base64url'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

export const encryptJson = (value: unknown): string => encryptText(JSON.stringify(value));
export function decryptJson<T>(blob: string): T | undefined {
  const text = decryptText(blob);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
