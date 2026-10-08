/**
 * Types shared between the Fastify server and the Vite client.
 * The client imports this file directly (Vite fs.allow covers ../shared).
 */

export type SourceKind = 'tiktok' | 'mp4';
export type ResolverKind = 'native' | 'ytdlp' | 'passthrough';
export type CodecFamily = 'h264' | 'h265' | 'av1' | 'vp9' | 'unknown';

/** Result of a server-side HTTP probe of a media URL (what the *server* observed, not the browser). */
export interface ServerProbe {
  url: string;
  status: number;
  ok: boolean;
  error?: string;
  finalUrl?: string;
  redirects: number;
  headers: {
    accessControlAllowOrigin?: string;
    accessControlAllowCredentials?: string;
    accessControlExposeHeaders?: string;
    acceptRanges?: string;
    contentType?: string;
    contentLength?: string;
    contentRange?: string;
    server?: string;
  };
  /** Requested with Origin: <client origin> and Range: bytes=0-1 */
  requestedOrigin: string;
  elapsedMs: number;
}

export interface MediaFormat {
  id: string;
  label: string;
  codec: CodecFamily;
  codecDetail?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  /**
   * A URL the browser may try to fetch itself (no cookies, expected to carry CORS headers).
   * Absent when no cookie-free URL is known for this format.
   */
  directUrl?: string;
  /** 'redirect' = www.tiktok.com/aweme/v1/play (302 to CDN); 'cdn' = resolved final CDN URL; 'origin' = plain MP4 URL as given */
  directKind?: 'redirect' | 'cdn' | 'origin';
  /** The redirecting URL when directKind is 'cdn' (lets the browser retry the redirect itself) */
  redirectUrl?: string;
  /**
   * The session-cookie-bound upstream URL (e.g. v16-webapp-prime.*.tiktok.com). Exposed only so the
   * diagnostics panel can demonstrate that it is NOT fetchable from the browser; the proxy uses it.
   */
  cookieBoundUrl?: string;
  /** Server-side observation for directUrl, if the server probed it */
  serverProbe?: ServerProbe;
  /** Proxy relay endpoint (/api/media/:id). Absent when upstream host is not allowlisted for relaying. */
  proxyUrl?: string;
  mediaId?: string;
  /** Upstream playback URL needs the session cookies the server captured (only the proxy can supply them). */
  requiresCookies: boolean;
  /** Epoch seconds at which the upstream URL stops working, if derivable from the URL */
  expiresAt?: number;
  /** Host of the URL the proxy would relay */
  upstreamHost?: string;
}

export interface ResolveResponse {
  source: SourceKind;
  resolver: ResolverKind;
  id: string;
  inputUrl: string;
  canonicalUrl?: string;
  title?: string;
  author?: string;
  duration?: number;
  width?: number;
  height?: number;
  cover?: string;
  formats: MediaFormat[];
  warnings: string[];
  /** Milliseconds the resolver took */
  elapsedMs: number;
  /** Which strategies were attempted and how they ended */
  attempts: { resolver: ResolverKind; ok: boolean; error?: string; elapsedMs: number }[];
}

export interface ResolveRequest {
  url: string;
  /** Ask the server to probe direct URLs with an Origin header (default true) */
  probe?: boolean;
  /** Browser origin to use for the server-side probe (defaults to request Origin header) */
  origin?: string;
}

export interface ReportRequest {
  mediaId?: string;
  url?: string;
  connection: 'direct' | 'proxy' | 'test' | 'local' | 'embed';
  renderer: string;
  ok: boolean;
  detail?: string;
}

export interface HealthResponse {
  ok: true;
  node: string;
  ytdlp: { available: boolean; version?: string; command?: string; error?: string };
  resolver: string;
  proxyAllowedHosts: string[];
  uptimeSec: number;
}

export interface ProbeRequest {
  url: string;
  origin?: string;
}
