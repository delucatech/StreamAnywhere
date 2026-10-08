import * as dns from 'node:dns';
import * as net from 'node:net';

/** Returns true when host matches an allowlist entry ("exact.host" or "*.suffix"). */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e === '*') return true;
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // ".tiktok.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === e;
  });
}

export function ipIsPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('::ffff:')) return ipIsPrivate(low.slice(7));
    return false;
  }
  return true; // unparseable -> treat as unsafe
}

export class UpstreamRejectedError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

/**
 * Validates that a URL is safe to contact from the server: https only, host allowlisted,
 * and (after DNS resolution) not pointing at a private/loopback address.
 */
export async function assertSafeUpstream(rawUrl: string, allowlist: string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamRejectedError('Invalid upstream URL', 'invalid_url');
  }
  if (url.protocol !== 'https:') throw new UpstreamRejectedError('Only https upstreams are allowed', 'bad_scheme');
  if (url.username || url.password) throw new UpstreamRejectedError('Credentials in URL are not allowed', 'bad_url');
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new UpstreamRejectedError(`Upstream host "${url.hostname}" is not in the proxy allowlist`, 'host_not_allowed');
  }
  if (net.isIP(url.hostname)) {
    if (ipIsPrivate(url.hostname)) throw new UpstreamRejectedError('Literal IP upstreams are not allowed', 'private_ip');
    return url;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.promises.lookup(url.hostname, { all: true });
  } catch (e) {
    throw new UpstreamRejectedError(`DNS lookup failed for ${url.hostname}: ${(e as Error).message}`, 'dns');
  }
  if (!addrs.length) throw new UpstreamRejectedError(`DNS returned no addresses for ${url.hostname}`, 'dns');
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) {
      throw new UpstreamRejectedError(`Upstream ${url.hostname} resolves to a private address`, 'private_ip');
    }
  }
  return url;
}
