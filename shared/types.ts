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

// ---------------------------------------------------------------- feed (TikTok-style stream)

/**
 * 'explore'  – TikTok's public Explore feed (no login, works on every server incl. IIS).
 * 'foryou'   – the personalised For You feed of a signed-in TikTok account. Needs the Node server
 *              with a real Chrome/Edge session (see server/src/session.ts); the signed-in browser
 *              profile does the request signing TikTok requires (msToken / X-Bogus / X-Gnarly).
 */
export type FeedSource = 'explore' | 'foryou';

export interface FeedAuthor {
  id?: string;
  uniqueId?: string;
  nickname?: string;
  avatar?: string;
}

export interface FeedStats {
  plays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

export interface FeedItem {
  id: string;
  canonicalUrl: string;
  author: FeedAuthor;
  desc?: string;
  createTime?: number;
  duration?: number;
  width?: number;
  height?: number;
  cover?: string;
  music?: string;
  stats: FeedStats;
  /** Same shape as the resolver output: direct (cookie-free) URL + proxy relay per quality. H.264 first. */
  formats: MediaFormat[];
}

export interface FeedRequest {
  source: FeedSource;
  /** Explore category id (see EXPLORE_CATEGORIES); default 120 = All */
  category?: number;
  /** Items wanted (server clamps) */
  count?: number;
  /** Opaque continuation from the previous response */
  cursor?: string;
}

export interface FeedResponse {
  source: FeedSource;
  items: FeedItem[];
  hasMore: boolean;
  cursor?: string;
  warnings: string[];
  elapsedMs: number;
}

// ---------------------------------------------------------------- search / profiles / follow / messages
// All served by the headless browser on the server (server/src/social.ts). Search and profiles work
// without a sign-in (TikTok's guest view); follow and messages need the signed-in session.

export interface UserSummary {
  id?: string;
  secUid?: string;
  uniqueId: string;
  nickname?: string;
  avatar?: string;
  signature?: string;
  verified?: boolean;
  followers?: number;
  following?: number;
  likes?: number;
  videos?: number;
  /** As TikTok reports it for the signed-in account (unknown when signed out) */
  followState?: FollowState;
}

export type FollowState = 'none' | 'following' | 'friends' | 'requested' | 'unknown';

export interface SearchRequest {
  q: string;
  /** Continuation from the previous response (0 for a new search) */
  offset?: number;
}

export interface SearchResponse {
  q: string;
  items: FeedItem[];
  users: UserSummary[];
  hasMore: boolean;
  offset: number;
  warnings: string[];
  elapsedMs: number;
}

export interface ProfileRequest {
  /** @handle without the @ */
  user: string;
  /** Videos already received (the server scrolls the profile page until it has more) */
  offset?: number;
  count?: number;
}

export interface ProfileResponse {
  user: UserSummary;
  items: FeedItem[];
  offset: number;
  hasMore: boolean;
  warnings: string[];
  elapsedMs: number;
}

export interface FollowRequest {
  user: string;
  follow: boolean;
}

export interface FollowResponse {
  user: string;
  followState: FollowState;
  warnings: string[];
}

export interface Conversation {
  /** Opaque id the server uses to find the thread again (its place in TikTok's list + title) */
  id: string;
  title: string;
  avatar?: string;
  preview?: string;
  time?: string;
  unread?: boolean;
}

export interface ChatMessage {
  id: string;
  from: 'me' | 'them' | 'unknown';
  text: string;
  time?: string;
  /** A shared video / image / other non-text message (text then describes it) */
  kind: 'text' | 'media' | 'other';
  link?: string;
}

export interface InboxResponse {
  conversations: Conversation[];
  warnings: string[];
  elapsedMs: number;
}

export interface ConversationRequest {
  /** A conversation id from the inbox, or "@handle" to open (or start) the thread with that user */
  id: string;
}

export interface ConversationResponse {
  conversation: Conversation;
  messages: ChatMessage[];
  /** Whether the page offers a message box (false = TikTok does not allow messaging this user) */
  canSend: boolean;
  warnings: string[];
  elapsedMs: number;
}

export interface SendMessageRequest {
  id: string;
  text: string;
}

export interface SendMessageResponse extends ConversationResponse {
  /** Whether the sent text appeared in the thread */
  sent: boolean;
}

export interface ExploreCategory {
  id: number;
  label: string;
}

/** Category ids captured from TikTok's own Explore page requests on 2026-10-08. */
export const EXPLORE_CATEGORIES: ExploreCategory[] = [
  { id: 120, label: 'All' },
  { id: 118, label: 'Singing & Dancing' },
  { id: 119, label: 'Comedy' },
  { id: 104, label: 'Sports' },
  { id: 112, label: 'Anime & Comics' },
  { id: 100, label: 'Relationship' },
  { id: 107, label: 'Shows' },
  { id: 101, label: 'Lipsync' },
  { id: 110, label: 'Daily Life' },
  { id: 105, label: 'Beauty Care' },
  { id: 102, label: 'Games' },
  { id: 103, label: 'Society' },
  { id: 114, label: 'Outfit' },
  { id: 109, label: 'Cars' },
  { id: 115, label: 'Food' },
  { id: 111, label: 'Animals' },
  { id: 113, label: 'Family' },
  { id: 106, label: 'Drama' },
  { id: 108, label: 'Fitness & Health' },
  { id: 117, label: 'Education' },
  { id: 116, label: 'Technology' },
];

export type SessionState = 'unsupported' | 'none' | 'login_pending' | 'logged_in' | 'error';

/** 'qr' = TikTok's QR login rendered by a headless page and shown in the feed page (works on servers
 *  without a display); 'window' = a visible browser window on the server machine. */
export type LoginMode = 'qr' | 'window';

export interface SessionLoginRequest {
  mode?: LoginMode;
}

/** Input forwarded to the server's sign-in page while TikTok asks for an extra verification there.
 *  Coordinates are pixels of the `pageShot` image (see SessionStatus.pageShotSize). */
export type SessionInputRequest =
  | { type: 'click'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; x2: number; y2: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: 'Enter' | 'Backspace' | 'Tab' | 'Escape' }
  /** Enter a verification code: the server puts it into TikTok's code field and submits */
  | { type: 'code'; code: string }
  /** Ask TikTok to e-mail the verification code again (the server presses "Resend"; once a minute) */
  | { type: 'resend' }
  | { type: 'shot' };

/** State of the server-side TikTok browser session (Node server only). */
export interface SessionStatus {
  /** false on servers that cannot run a browser (IIS handler, hosted containers without Chrome) */
  supported: boolean;
  state: SessionState;
  username?: string;
  nickname?: string;
  avatar?: string;
  /** Executable the server uses (for display) */
  browser?: string;
  error?: string;
  /** Human-readable hint for the UI */
  message?: string;
  /** true while the server is still checking a saved browser profile (poll again in a moment) */
  probing?: boolean;
  /** While login_pending: which flow is running */
  loginMode?: LoginMode;
  /** While a QR login is pending: the current QR code as a data: URL (PNG), refreshed as TikTok rotates it */
  qr?: string;
  /** 'verify' = the phone confirmed but TikTok wants an extra identity verification inside the server's
   *  browser page (error 2135); `pageShot` then shows that page live and POST /api/session/input drives it. */
  qrState?: 'new' | 'scanned' | 'expired' | 'verify';
  /** ms epoch when TikTok retires the current QR (the server fetches a new one just before) */
  qrExpiresAt?: number;
  /** While a QR login shows no QR (or a verification is pending): a screenshot (data: URL, JPEG) of the server's page */
  pageShot?: string;
  /** Pixel size of `pageShot` (= the page viewport), for mapping clicks */
  pageShotSize?: { w: number; h: number };
  /** While qrState is 'verify': where TikTok's verification dialog stands.
   *  'choose' = it lists methods (the server picks Email by itself), 'sending' = method chosen, waiting for
   *  the code field, 'code' = a code field is shown: send it with {type:'code'}. */
  verifyStep?: 'choose' | 'sending' | 'code';
  /** Text of TikTok's verification dialog (what it asks for, masked address the code went to) */
  verifyText?: string;
  /** ms epoch when the server pressed "Send code" (the e-mailed code stays valid for hours; the attempt is
   *  held for 48 h, so the user can come back later - even after a page refresh - and enter it) */
  codeSentAt?: number;
  /** ms epoch until which the server keeps this verification (and TikTok's dialog) alive */
  verifyUntil?: number;
  /** Outcome of the last code the user entered ('checking' until TikTok answers) */
  verifyResult?: { state: 'checking' | 'accepted' | 'rejected' | 'unknown'; text?: string; at: number };
  /** Something the user should know about the current attempt (e.g. "started over: TikTok's QR session
   *  expired while waiting for the e-mail code; the verification is re-used") */
  notice?: string;
}
