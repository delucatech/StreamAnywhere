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
  source: 'tiktok' | 'mp4';
  stats: { requests: number; bytes: number; lastStatus?: number };
}

const records = new Map<string, MediaRecord>();

export function registerMedia(input: Omit<MediaRecord, 'id' | 'createdAt' | 'stats'>): MediaRecord {
  // De-duplicate identical upstream URLs so reloading the same video reuses the id.
  for (const r of records.values()) {
    if (r.url === input.url && r.expiresAt > Date.now()) return r;
  }
  const rec: MediaRecord = {
    ...input,
    id: randomBytes(9).toString('base64url'),
    createdAt: Date.now(),
    stats: { requests: 0, bytes: 0 },
  };
  records.set(rec.id, rec);
  sweep();
  return rec;
}

export function getMedia(id: string): MediaRecord | undefined {
  const r = records.get(id);
  if (!r) return undefined;
  if (r.expiresAt <= Date.now()) {
    records.delete(id);
    return undefined;
  }
  return r;
}

export function defaultExpiry(): number {
  return Date.now() + config.mediaTtlMs;
}

function sweep(): void {
  const now = Date.now();
  for (const [id, r] of records) if (r.expiresAt <= now) records.delete(id);
}

export const mediaCount = (): number => records.size;
