import { randomBytes } from 'node:crypto';
import { config } from './config';

export interface MediaRecord {
  id: string;
  /** Upstream URL the proxy relays */
  url: string;
  /** Extra request headers (Referer, Cookie...) required upstream */
  headers: Record<string, string>;
  createdAt: number;
  expiresAt: number;
  label: string;
  source: 'tiktok' | 'youtube' | 'mp4';
  /**
   * Relay in bounded Range chunks instead of one streaming request: googlevideo.com throttles an
   * open-ended request to ~50 KB/s but serves a bounded range (up to 10 MB measured) at full speed.
   */
  chunked?: boolean;
  stats: { requests: number; bytes: number; lastStatus?: number };
}

const records = new Map<string, MediaRecord>();
/** Upstream URL -> record id, so a feed batch (over a hundred formats) registers in constant time. */
const byUrl = new Map<string, string>();
let lastSweep = 0;

export function registerMedia(input: Omit<MediaRecord, 'id' | 'createdAt' | 'stats'>): MediaRecord {
  // De-duplicate identical upstream URLs so reloading the same video reuses the id.
  const existingId = byUrl.get(input.url);
  const existing = existingId ? records.get(existingId) : undefined;
  if (existing && existing.expiresAt > Date.now()) return existing;
  const rec: MediaRecord = {
    ...input,
    id: randomBytes(9).toString('base64url'),
    createdAt: Date.now(),
    stats: { requests: 0, bytes: 0 },
  };
  records.set(rec.id, rec);
  byUrl.set(rec.url, rec.id);
  if (Date.now() - lastSweep > 60_000) sweep();
  return rec;
}

export function getMedia(id: string): MediaRecord | undefined {
  const r = records.get(id);
  if (!r) return undefined;
  if (r.expiresAt <= Date.now()) {
    remove(r);
    return undefined;
  }
  return r;
}

export function defaultExpiry(): number {
  return Date.now() + config.mediaTtlMs;
}

function remove(r: MediaRecord): void {
  records.delete(r.id);
  if (byUrl.get(r.url) === r.id) byUrl.delete(r.url);
}

function sweep(): void {
  const now = Date.now();
  lastSweep = now;
  for (const r of records.values()) if (r.expiresAt <= now) remove(r);
}

export const mediaCount = (): number => records.size;
