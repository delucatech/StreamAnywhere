/**
 * Types shared between the Fastify server and the Vite client.
 * The client imports this file directly (Vite fs.allow covers ../shared).
 */

export type SourceKind = 'tiktok' | 'youtube' | 'instagram' | 'facebook' | 'mp4';
export type ResolverKind = 'native' | 'ytdlp' | 'passthrough';

/**
 * A platform is one "app" on the launcher (home.html): its own feed, search and sign-in. The feed
 * page is shared; `platform` in a request tells the server which one it is asking about.
 */
export type Platform = 'tiktok' | 'youtube' | 'instagram' | 'facebook';
export const PLATFORM_IDS: Platform[] = ['tiktok', 'youtube', 'instagram', 'facebook'];
export const platformOf = (v: unknown): Platform => (v === 'youtube' ? 'youtube' : v === 'instagram' ? 'instagram' : v === 'facebook' ? 'facebook' : 'tiktok');
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
  /**
   * YouTube hands out picture and sound as two files (no muxed format without a PO token); the
   * player then fetches this second file (proxy relay, AAC in fragmented MP4) and plays both in sync.
   */
  audioProxyUrl?: string;
  audioMediaId?: string;
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
  /** Feed-page problem reports: what went wrong ('feed batch', 'resolve', 'player', 'page error'), where, on what */
  kind?: string;
  platform?: Platform;
  page?: string;
  ua?: string;
}

export interface HealthResponse {
  ok: true;
  node: string;
  ytdlp: { available: boolean; version?: string; command?: string; error?: string };
  /** The warm yt-dlp Python processes (see server/scripts/ytdlp-daemon.py) */
  ytdlpDaemon?: { enabled: boolean; python?: string; running: number; busy: number; version?: string };
  /** Merges YouTube's separate video and audio files (the Video Downloader) */
  ffmpeg?: { available: boolean; path?: string; version?: string; error?: string };
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
  /** Whether the signed-in account follows this one, when the source says (TikTok items carry `relation`) */
  followState?: FollowState;
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
  /** Which platform's feed (default tiktok) */
  platform?: Platform;
  source: FeedSource;
  /** Explore category id (see EXPLORE_CATEGORIES / YOUTUBE_CATEGORIES); default = All */
  category?: number;
  /** Items wanted (server clamps) */
  count?: number;
  /** Opaque continuation from the previous response */
  cursor?: string;
  /**
   * The viewer has nothing on screen: a server with nothing ready answers with videos it served
   * earlier (FeedResponse.stale) instead of making them wait. Not sent while videos are on screen
   * (a saved feed, an earlier batch): those were the server's last videos anyway, and the viewer
   * wants fresh ones, prefetched ahead, so the wait for the source costs them nothing.
   */
  quick?: boolean;
  /**
   * The home screen filling a device's saved feeds ahead of time: answer only with what is ready
   * (the stock, or earlier videos), start nothing (no fill, no browser, no sign-in check), and
   * answer empty rather than wait.
   */
  prefetch?: boolean;
  /**
   * The home screen, for an app this device already holds a feed of: hand out nothing, but top the
   * feed's stock up in the background when it is low and the server has served that feed before,
   * so the app finds fresh videos ready when it is opened. Answers empty at once.
   */
  warm?: boolean;
}

export interface FeedResponse {
  source: FeedSource;
  items: FeedItem[];
  hasMore: boolean;
  cursor?: string;
  warnings: string[];
  elapsedMs: number;
  /**
   * The server had nothing ready and answered with videos it served earlier (its last good batch,
   * kept on disk) instead of making the viewer wait; fresh ones are being fetched. Their play URLs
   * may have expired: the client gets new ones from the video's page when one fails.
   */
  stale?: boolean;
  /** A line for the viewer about a stale answer: what was served instead of the feed asked for (e.g. Explore videos while For You loads) */
  note?: string;
}

/** GET /api/feed/progress?platform=: the step a slow fill is on (no text when nothing is running). */
export interface FeedProgress {
  platform: Platform;
  /** e.g. "Starting Instagram's browser on the server…" */
  text?: string;
  /** How long the job has been on this step */
  forMs?: number;
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
  platform?: Platform;
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
  /** Set when this is an earlier answer (this many seconds old) and the server is fetching a fresh one: ask again in a little while */
  cachedAgeSec?: number;
}

export interface ProfileRequest {
  platform?: Platform;
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
  /** As on SearchResponse: an earlier answer, a fresh one is being fetched */
  cachedAgeSec?: number;
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

/**
 * YouTube guest "Explore" categories: each is a hashtag whose Shorts tab (youtube.com/hashtag/<tag>/shorts)
 * the server lists with yt-dlp - vertical videos, no sign-in, about 30 per page (measured 2026-10-12).
 * id 0 = All rotates through the others.
 */
export interface YouTubeCategory {
  id: number;
  label: string;
  /** Hashtag without the # */
  tag: string;
}
export const YOUTUBE_CATEGORIES: YouTubeCategory[] = [
  { id: 0, label: 'All', tag: 'shorts' },
  { id: 1, label: 'Funny', tag: 'funny' },
  { id: 2, label: 'Music', tag: 'music' },
  { id: 3, label: 'Dance', tag: 'dance' },
  { id: 4, label: 'Gaming', tag: 'gaming' },
  { id: 5, label: 'Sports', tag: 'sports' },
  { id: 6, label: 'Cats', tag: 'cats' },
  { id: 7, label: 'Dogs', tag: 'dogs' },
  { id: 8, label: 'Food', tag: 'food' },
  { id: 9, label: 'Cars', tag: 'cars' },
  { id: 10, label: 'Travel', tag: 'travel' },
  { id: 11, label: 'Fitness', tag: 'fitness' },
  { id: 12, label: 'Science', tag: 'science' },
  { id: 13, label: 'DIY', tag: 'diy' },
  { id: 14, label: 'Nature', tag: 'nature' },
  { id: 15, label: 'Anime', tag: 'anime' },
  { id: 16, label: 'Football', tag: 'football' },
  { id: 17, label: 'Basketball', tag: 'basketball' },
  { id: 18, label: 'Cooking', tag: 'cooking' },
  { id: 19, label: 'Tech', tag: 'tech' },
];

/**
 * Instagram "Reels" tab (the platform needs a sign-in): Instagram has no global feed to list, so each
 * category is a list of big public accounts whose latest Reels the server rotates through (accounts
 * verified 2026-10-13 to list 8+ Reels). id 0 = All rotates through every category.
 */
export interface InstagramCategory {
  id: number;
  label: string;
  /** @handles without the @ */
  accounts: string[];
}
export const INSTAGRAM_CATEGORIES: InstagramCategory[] = [
  { id: 0, label: 'All', accounts: [] },
  { id: 1, label: 'Funny', accounts: ['9gag', 'ladbible', 'unilad', 'memezar', 'funnyordie', 'barstoolsports', 'comedycentral', 'jimmyfallon'] },
  { id: 2, label: 'Animals', accounts: ['thedodo', 'animalplanet', 'dogsofinstagram', 'catsofinstagram', 'sandiegozoo', 'montereybayaquarium', 'itsdougthepug'] },
  { id: 3, label: 'Sports', accounts: ['espn', 'nba', 'bleacherreport', '433', 'sportscenter', 'nfl', 'championsleague', 'fifaworldcup', 'ufc', 'wwe'] },
  { id: 4, label: 'Music', accounts: ['spotify', 'billboard', 'applemusic', 'mtv', 'rollingstone', 'genius', 'vevo', 'taylorswift', 'arianagrande', 'billieeilish'] },
  { id: 5, label: 'Food', accounts: ['buzzfeedtasty', 'foodnetwork', 'gordongram', 'bonappetitmag', 'delish', 'nytcooking', 'jamieoliver', 'thefeedfeed'] },
  { id: 6, label: 'Travel', accounts: ['beautifuldestinations', 'lonelyplanet', 'natgeotravel', 'travelandleisure', 'airbnb', 'cntraveler', 'earthpix', 'roamtheplanet', 'passionpassport'] },
  { id: 7, label: 'Science', accounts: ['nasa', 'sciencechannel', 'iflscience', 'nasahubble', 'spacex', 'natgeo', 'discovery', 'smithsonian'] },
  { id: 8, label: 'Tech', accounts: ['verge', 'mkbhd', 'wired', 'techcrunch', 'apple', 'samsung', 'google', 'microsoft', 'engadget'] },
  { id: 9, label: 'Gaming', accounts: ['playstation', 'xbox', 'gamespot', 'fortnite', 'minecraft', 'leagueoflegends', 'pokemon', 'twitch'] },
  { id: 10, label: 'Cars', accounts: ['topgear', 'ferrari', 'porsche', 'lamborghini'] },
];

/**
 * Facebook "Reels" tab: like Instagram's, a rotation over big public Pages - but Facebook shows a
 * signed-out visitor a Page's Reels tab (`facebook.com/<page>/reels/`, its latest 10 reels with
 * their MP4 URLs in the page's own JSON), so no sign-in is needed for it. Pages verified 2026-10-15
 * to list 10 reels to a guest. id 0 = All rotates through every category.
 */
export interface FacebookCategory {
  id: number;
  label: string;
  /** Page slugs (facebook.com/<slug>) */
  pages: string[];
}
export const FACEBOOK_CATEGORIES: FacebookCategory[] = [
  { id: 0, label: 'All', pages: [] },
  { id: 1, label: 'Funny', pages: ['9gag', 'LADbible', 'uniladmag', 'barstoolsports', 'ComedyCentral', 'JimmyFallon', 'FallonTonight', 'teamcoco', 'thelatelateshow', 'colbertlateshow', 'BuzzFeed', 'viralhog', 'DudePerfect', 'mrbeast', 'insider'] },
  { id: 2, label: 'Animals', pages: ['AnimalPlanet', 'thedodosite', 'bbcearth', 'sharkweek', 'natgeo', 'NatGeoTV'] },
  { id: 3, label: 'Sports', pages: ['ESPN', 'nba', 'bleacherreport', 'NFL', 'nflnetwork', 'ChampionsLeague', 'fifaworldcup', 'premierleague', 'foxsports', 'CBSSports', 'SkySports', 'mlb', 'NHL', 'PGATour', 'NASCAR', 'wwe', 'olympics', 'MotoGP'] },
  { id: 4, label: 'Music', pages: ['Spotify', 'Billboard', 'MTV', 'RollingStone', 'TaylorSwift', 'arianagrande', 'billieeilish', 'shakira', 'eminem', 'rihanna', 'theweeknd', 'JustinBieber', 'katyperry', 'ladygaga'] },
  { id: 5, label: 'Food', pages: ['buzzfeedtasty', 'FoodNetwork', 'gordonramsay', 'delish', 'nytcooking', 'jamieoliver', 'FirstWeFeast', 'Starbucks', 'OREO'] },
  { id: 6, label: 'Travel', pages: ['BeautifulDestinations', 'lonelyplanet', 'natgeotravel', 'airbnb', 'earthpix', 'PassionPassport', 'RedBull', 'gopro'] },
  { id: 7, label: 'Science', pages: ['NASAHubble', 'ScienceChannel', 'IFLScience', 'Discovery', 'Smithsonian'] },
  { id: 8, label: 'Tech', pages: ['verge', 'MKBHD', 'wired', 'techcrunch', 'Google', 'Microsoft', 'cnet'] },
  { id: 9, label: 'Gaming', pages: ['playstation', 'xbox', 'GameSpot', 'FortniteGame', 'minecraft', 'Pokemon', 'NintendoAmerica', 'ign', 'kotaku', 'polygon', 'Steam', 'epicgames', 'RiotGames', 'Blizzard', 'ubisoft'] },
  { id: 10, label: 'Cars', pages: ['topgear', 'Ferrari', 'porsche', 'Lamborghini', 'BMW', 'MercedesBenz', 'toyota', 'RedBullMotorsports', 'redbullracing', 'MercedesAMGF1', 'ScuderiaFerrari'] },
  { id: 11, label: 'Entertainment', pages: ['nickelodeon', 'Disney', 'DisneyPlus', 'Pixar', 'hbomax', 'PrimeVideo', 'Marvel', 'StarWars', 'GQ', 'Vogue', 'BBCOne', 'LEGO', 'adidas', 'PUMA'] },
];

export type SessionState = 'unsupported' | 'none' | 'login_pending' | 'logged_in' | 'error';

/** 'qr' = TikTok's QR login rendered by a headless page and shown in the feed page (works on servers
 *  without a display); 'window' = a visible browser window on the server machine (every platform);
 *  'cookies' = YouTube / Instagram / Facebook: the cookies of a browser that is signed in, pasted or uploaded (works everywhere). */
export type LoginMode = 'qr' | 'window' | 'cookies';

export interface SessionLoginRequest {
  /** Which platform to sign in to (default tiktok) */
  platform?: Platform;
  mode?: LoginMode;
  /** mode 'cookies': the text of a cookies.txt export (Netscape format), a cookie extension's JSON export, or a Cookie: header */
  cookies?: string;
}

/** Body of /api/session/logout and /api/session/cancel */
export interface SessionActionRequest {
  platform?: Platform;
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
  /** Which platform's sign-in this describes (absent = tiktok) */
  platform?: Platform;
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

// ---------------------------------------------------------------- Video Downloader (download.html)

/** Where a pasted link points; only YouTube is served so far (the server says which are on). */
export type DownloadSource = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'other';

export interface DownloadProbeRequest {
  url: string;
}

/** One thing the user can save: a video at a given quality (merged with the best audio), or the audio alone. */
export interface DownloadOption {
  id: string;
  kind: 'video' | 'audio';
  /** "1080p", "720p60", "Audio only" */
  label: string;
  /** "MP4 · H.264 + AAC", "M4A · AAC 128 kbps" */
  detail: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  /** Container of the saved file */
  ext: string;
  /** Sum of the parts' sizes when yt-dlp knows them (an estimate when `sizeIsEstimate`) */
  sizeBytes?: number;
  sizeIsEstimate?: boolean;
  /** The option the page selects first */
  recommended?: boolean;
}

export interface DownloadProbeResponse {
  /** Handle for /api/download/start (the server keeps the lookup for a while) */
  probeId: string;
  source: DownloadSource;
  id: string;
  url: string;
  title?: string;
  author?: string;
  duration?: number;
  cover?: string;
  options: DownloadOption[];
  warnings: string[];
  elapsedMs: number;
}

export interface DownloadStartRequest {
  probeId: string;
  optionId: string;
}

export type DownloadJobState = 'queued' | 'downloading' | 'merging' | 'done' | 'error' | 'cancelled';

export interface DownloadProgress {
  /** 0-100 of the whole job when the total is known */
  percent?: number;
  downloadedBytes: number;
  totalBytes?: number;
  speedBps?: number;
  etaSec?: number;
  /** "video", "audio", "video + audio" — what is being fetched right now */
  part?: string;
}

export interface DownloadJob {
  jobId: string;
  state: DownloadJobState;
  source: DownloadSource;
  title?: string;
  option: DownloadOption;
  progress: DownloadProgress;
  /** Set when done: the name the browser saves the file as, its size, and where to fetch it */
  fileName?: string;
  sizeBytes?: number;
  fileUrl?: string;
  error?: string;
  /** How many jobs are ahead of this one while queued */
  queuePosition?: number;
  startedAt: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------- Video Library (library.html)
// Links saved to one library that every browser of the site shares (the server keeps it); videos
// downloaded for in-app playback stay in the browser that downloaded them (IndexedDB).

export type LibrarySource = DownloadSource;

export interface LibraryCategory {
  id: string;
  name: string;
  createdAt: number;
}

export interface LibraryEntry {
  id: string;
  /** The link as it was pasted (scheme added) */
  url: string;
  /** One form per video (watch?v=ID, @user/video/ID, reel/CODE): duplicates are found by it */
  canonicalUrl: string;
  source: LibrarySource;
  /** The platform's own id of the video */
  sourceId?: string;
  title: string;
  /** The title was typed by the user: a later lookup must not replace it */
  titleEdited?: boolean;
  author?: string;
  duration?: number;
  width?: number;
  height?: number;
  /** Thumbnail cached on the server (/api/library/thumb/:id?v=…); absent = placeholder */
  thumb?: string;
  categoryIds: string[];
  addedAt: number;
  updatedAt: number;
  /** The metadata lookup: running, done, or failed (the entry stays, with an editable title) */
  meta: 'pending' | 'ok' | 'failed';
  metaError?: string;
  /** The source said the video is gone (private, removed): it cannot be downloaded again */
  unavailable?: { at: number; reason: string };
  /** A plain file link: the Content-Type the link answered with at the lookup (video/x-matroska, video/mp4...) */
  mediaType?: string;
  /** The video downloaded to the library on the server ("Download to library"): every device fetches it from there */
  file?: LibraryFile;
}

/**
 * A copy of the video stored on the server (LIBRARY_DIR/files/<id>.mp4). The server fetches the
 * link once (a direct file, or the best quality that plays everywhere for a platform video) and
 * turns anything that is not an MP4 the browsers decode (MKV, WebM, 10-bit H.264, AC-3 sound...)
 * into one with ffmpeg; browsers then download their in-app copy from /api/library/file/:id.
 */
export interface LibraryFile {
  state: 'queued' | 'downloading' | 'converting' | 'ready' | 'error';
  /** 0-100 while downloading / converting, when the total is known */
  percent?: number;
  /** What is happening right now, for the page ("Fetching 120 MB of 700 MB · 3.1 MB/s") */
  text?: string;
  error?: string;
  /** Set once ready */
  sizeBytes?: number;
  ext?: string;
  mime?: string;
  /** Codec families as the page's playability check names them: h264 / h265 / vp9 / av1, aac */
  vcodec?: string;
  acodec?: string;
  /** What the server did to the file: "kept as it was", "remuxed from MKV, sound re-encoded to AAC (was AC-3)" */
  note?: string;
  /** The original file's name (the link's last segment, or the server's Content-Disposition) */
  originalName?: string;
  /** Platform videos: the quality that was fetched ("1080p") */
  label?: string;
  startedAt: number;
  finishedAt?: number;
  /** Imports restarted after a server restart (given up after a couple) */
  attempts: number;
}

export interface LibraryState {
  /** Grows with every change; GET /api/library?rev=N answers { rev, unchanged: true } when nothing changed */
  rev: number;
  entries: LibraryEntry[];
  categories: LibraryCategory[];
}

export interface LibrarySaveRequest {
  url: string;
  categoryIds?: string[];
  /**
   * What the sender already knows about the video (the feed saving the video in view): shown at
   * once and kept when the server's own lookup fails; the lookup's answer wins otherwise.
   */
  hint?: LibrarySaveHint;
}

export interface LibrarySaveHint {
  title?: string;
  author?: string;
  duration?: number;
  width?: number;
  height?: number;
  /** A cover URL the server copies to its thumbnails (platform cover URLs expire within days) */
  cover?: string;
}

export interface LibrarySaveResponse {
  entry: LibraryEntry;
  /** The link was already in the library: `entry` is the existing one */
  duplicate: boolean;
  /** POST /api/library/import: the server started fetching the video (false = a copy is already there) */
  importStarted?: boolean;
  state: LibraryState;
}

export interface LibraryEntryPatch {
  title?: string;
  categoryIds?: string[];
}

export interface LibraryCategoryRequest {
  name: string;
}

/**
 * One quality a browser can get right now. 'job' = a server-side download (YouTube: picture and
 * sound are separate files, merged with ffmpeg) fetched from /api/download/jobs/:id/file when done;
 * 'stream' = a ready MP4 the browser fetches itself (cookie-free CDN URL and/or the same-origin proxy).
 */
export interface LibraryOption extends DownloadOption {
  via: 'job' | 'stream';
  directUrl?: string;
  proxyUrl?: string;
}

export interface LibraryOptionsResponse {
  entryId: string;
  /** For 'job' options: the lookup handle for /api/download/start (valid for a while) */
  probeId?: string;
  options: LibraryOption[];
  warnings: string[];
  elapsedMs: number;
}

// ---------------------------------------------------------------- Live TV (livetv.html)
// Providers (M3U playlists, Xtream Codes accounts) are kept on the server for every browser of
// the site, their credentials encrypted at rest; channels are listed from the server's cached
// copy of each playlist; streams reach the browser through the server, never with the provider's
// credentials in them.

export type LiveTvProviderKind = 'm3u' | 'xtream';

export interface LiveTvProvider {
  id: string;
  kind: LiveTvProviderKind;
  name: string;
  enabled: boolean;
  /** The built-in preset this provider was added from, if any */
  preset?: string;
  /** M3U: the playlist URL (the owner's own setting, shown in the edit form) */
  url?: string;
  /** Xtream: the panel's address and the account name; the password never leaves the server */
  server?: string;
  username?: string;
  hasPassword?: boolean;
  /** An XMLTV guide URL given explicitly (optional) */
  epgUrl?: string;
  /** Where the guide comes from: the explicit URL, the playlist's own header, the panel's xmltv.php, or nowhere */
  epgSource: 'url' | 'playlist' | 'panel' | 'none';
  createdAt: number;
  updatedAt: number;
  /** The last channel list refresh */
  refresh: { state: 'never' | 'running' | 'ok' | 'error'; at?: number; error?: string; channels: number; groups: number; ms?: number };
  /** The guide: when it was last loaded, how many of this provider's channels have programmes */
  epg: { state: 'none' | 'running' | 'ok' | 'error'; at?: number; error?: string; channels: number; programmes: number };
  /** Xtream: what the panel said about the account at the last refresh / test */
  account?: LiveTvAccount;
}

export interface LiveTvAccount {
  status?: string;
  expiresAt?: number;
  maxConnections?: number;
  activeConnections?: number;
}

/** POST /api/livetv/providers (add) and POST /api/livetv/providers/:id (edit: only the fields sent change; an empty password keeps the saved one) */
export interface LiveTvProviderInput {
  kind?: LiveTvProviderKind;
  name?: string;
  url?: string;
  server?: string;
  username?: string;
  password?: string;
  epgUrl?: string;
  enabled?: boolean;
  preset?: string;
}

export interface LiveTvChannel {
  /** "<providerId>:<channelId>": what favorites, the guide and tuning refer to */
  key: string;
  providerId: string;
  name: string;
  /** The group / category as the provider names it ("News", "Sports", a country...) */
  group: string;
  logo?: string;
  /** Guide id (tvg-id / epg_channel_id) */
  epgId?: string;
  /** Channel number (tvg-chno / the panel's num) */
  number?: number;
  /** The playlist names DRM license keys for this channel: it cannot play here */
  drm?: boolean;
}

export interface LiveTvState {
  /** Grows with every change to the providers or preferences; GET /api/livetv?rev=N answers { rev, unchanged: true } */
  rev: number;
  /** Grows when any provider's channel list changes (GET /api/livetv/channels?rev=N) */
  channelsRev: number;
  providers: LiveTvProvider[];
  prefs: LiveTvPrefs;
  /** ffmpeg is there: raw MPEG-TS streams are remuxed into HLS for the browser */
  remux: boolean;
}

export interface LiveTvChannelsResponse {
  channelsRev: number;
  channels: LiveTvChannel[];
}

export interface LiveTvPrefs {
  favorites: string[];
  lastKey?: string;
  lastAt?: number;
}

/** A community playlist offered in Settings; added like any M3U provider */
export interface LiveTvPreset {
  id: string;
  /** "IPTV-org", "Free-TV": the picker groups presets by their source */
  source: string;
  name: string;
  description: string;
  url: string;
  epgUrl?: string;
  /** Roughly how many channels the list had when it was last checked */
  approxChannels?: number;
}

export interface LiveTvTestRequest extends LiveTvProviderInput {
  /** Test a saved provider (its saved password is used when none is typed) */
  id?: string;
}

export interface LiveTvTestResponse {
  ok: boolean;
  message: string;
  channels?: number;
  groups?: number;
  account?: LiveTvAccount;
  /** The guide source the provider names (none for a plain playlist without one) */
  epgSource?: LiveTvProvider['epgSource'];
  elapsedMs: number;
}

export interface LiveTvTuneRequest {
  key: string;
}

export type LiveTvStreamKind = 'hls' | 'remux' | 'progressive';

/**
 * What the server found when it opened the channel's stream: a playable same-origin URL (HLS, a
 * remuxed HLS copy of a raw MPEG-TS stream, or a progressive file), an unavailable stream (the
 * provider answered with an error, nothing, or too slowly), or a format the browser cannot play here.
 */
export interface LiveTvTuneResponse {
  key: string;
  state: 'ok' | 'unavailable' | 'unsupported';
  kind?: LiveTvStreamKind;
  playUrl?: string;
  /** Technical detail (status, content type), for the player's message and the log */
  detail?: string;
  message?: string;
  elapsedMs: number;
}

export interface LiveTvProgramme {
  /** ms since the epoch */
  start: number;
  stop: number;
  title: string;
  desc?: string;
  category?: string;
}

/** GET /api/livetv/guide?keys=a,b,c: what is on now and next on those channels */
export interface LiveTvGuideNowResponse {
  now: Record<string, { now?: LiveTvProgramme; next?: LiveTvProgramme }>;
  /** A guide is still being loaded for one of the providers asked about: ask again in a moment */
  loading: boolean;
}

/** GET /api/livetv/guide/:key: the channel's programmes around now */
export interface LiveTvChannelGuideResponse {
  key: string;
  programmes: LiveTvProgramme[];
  loading: boolean;
  /** Why there is nothing: the provider has no guide, the channel is not in it... */
  note?: string;
}
