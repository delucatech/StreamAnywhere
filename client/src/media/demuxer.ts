/**
 * Streaming MP4 demuxer built on mp4box.js.
 *
 *  fetch() (streaming body) -> MP4BoxBuffer chunks with fileStart -> ISOFile.appendBuffer()
 *  -> onReady (moov parsed) -> setExtractionOptions per track -> onSamples callbacks.
 *
 *  - Progressive download from byte 0; if mp4box asks for a later file position (e.g. moov
 *    stored after mdat) the fetch is restarted there with a Range request.
 *  - seek(t) asks mp4box for the file offset of the preceding random-access point. mp4box answers
 *    with the end of the data it still holds in memory after that point, so the download is only
 *    restarted when that offset lies beyond what has been fetched; when the file is already
 *    complete in memory the samples are simply re-emitted (a Range request at EOF would be 416).
 *  - pause()/resume() stop pulling from the network when the decoder queues are full.
 *  - Fragmented files (YouTube: moov + sidx, then moof/mdat pairs): mp4box only knows the samples
 *    of the fragments it has parsed, so a seek beyond the downloaded part is answered from the
 *    sidx index instead: the fetch restarts at that fragment's byte offset and mp4box is told to
 *    parse from there (its fragments carry tfdt timestamps, so the times stay absolute).
 *  - Recording (the feed's media cache): the bytes received from the start of the file are kept
 *    (up to RECORD_MAX) as long as they are contiguous; recording() hands them out as the parts
 *    of a Blob, with whether they are the whole file. A download that jumps (moov at the end, a
 *    seek past the downloaded part) freezes the recording at the prefix it has.
 *  - A `prefix` (the cached head of the file from an earlier visit) is read with slice() like a
 *    local file; when it ends before the file does, the download continues from the network at
 *    that byte, so the first frames come from disk and the rest streams.
 */
import { createFile, MP4BoxBuffer, type ISOFile, type Movie, type Sample } from 'mp4box';
import { describeTrack, type TrackInfo } from './codecConfig';

export interface DemuxerCallbacks {
  onReady(info: Movie, video: TrackInfo | undefined, audio: TrackInfo | undefined): void;
  onVideoSamples(samples: Sample[]): void;
  onAudioSamples(samples: Sample[]): void;
  onProgress(bytesLoaded: number, totalBytes: number): void;
  /** The network stream reached EOF (all bytes delivered to mp4box) */
  onEnd(): void;
  onError(err: Error): void;
  onLog(msg: string): void;
}

export interface DemuxerStats {
  bytesLoaded: number;
  totalBytes: number;
  /** How far into the file the current download has got (every byte received, merged or not) */
  downloadedTo: number;
  rangeSupported: boolean | undefined;
  isProgressive: boolean | undefined;
  restarts: number;
  httpStatus: number;
  contentType: string;
}

const CHUNK_MERGE_TARGET = 256 * 1024;
/** The recording stops growing past this (a prefix is still kept): memory on small devices */
const RECORD_MAX = 32 * 1024 * 1024;

/** The head of the file from the media cache: served first, the rest comes from `url`. */
export interface MediaPrefix {
  blob: Blob;
  /** Size of the whole file (known from the earlier download) */
  total: number;
  /** The blob is the whole file: nothing is fetched */
  complete: boolean;
}
/** What the demuxer has of the file, from byte 0, for the media cache */
export interface MediaRecording {
  parts: BlobPart[];
  bytes: number;
  total: number;
  complete: boolean;
}

export class Mp4Demuxer {
  private file: ISOFile;
  private abort?: AbortController;
  private filePos = 0;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private destroyed = false;
  private fetchGen = 0;
  private videoTrack?: TrackInfo;
  private audioTrack?: TrackInfo;
  private ready = false;
  private fragmented = false;
  /** The current download reached EOF (every byte of the file went through mp4box) */
  private ended = false;
  /** The bytes received from byte 0 on, contiguous (see recording()) */
  private rec: BlobPart[] = [];
  private recBytes = 0;
  /** The download jumped (or the cap was reached): the recording stays the prefix it is */
  private recFrozen = false;
  readonly stats: DemuxerStats = {
    bytesLoaded: 0,
    totalBytes: 0,
    downloadedTo: 0,
    rangeSupported: undefined,
    isProgressive: undefined,
    restarts: 0,
    httpStatus: 0,
    contentType: '',
  };

  constructor(
    private readonly url: string,
    private readonly fetchInit: RequestInit | undefined,
    private readonly cb: DemuxerCallbacks,
    /** A file in this browser instead of a URL: read with slice() (a "Range" that never fails), no network */
    private readonly blob?: Blob,
    /** The cached head of the file (feed media cache); `url` serves what comes after it */
    private readonly prefix?: MediaPrefix,
  ) {
    this.file = createFile();
    if (prefix && !blob) {
      this.rec = [prefix.blob];
      this.recBytes = prefix.blob.size;
      if (prefix.total > 0) this.stats.totalBytes = prefix.total;
    }
    this.file.onError = (e: unknown) => this.cb.onError(new Error(`mp4box: ${String(e)}`));
    this.file.onReady = (info: Movie) => this.handleReady(info);
    this.file.onSamples = (id: number, _user: unknown, samples: Sample[]) => {
      if (this.destroyed) return;
      if (this.videoTrack && id === this.videoTrack.id) this.cb.onVideoSamples(samples);
      else if (this.audioTrack && id === this.audioTrack.id) this.cb.onAudioSamples(samples);
    };
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** The file as far as it is here from byte 0 (the parts of a Blob); undefined when nothing is. */
  recording(): MediaRecording | undefined {
    if (this.blob || !this.recBytes) return undefined;
    const total = this.stats.totalBytes;
    return { parts: this.rec.slice(), bytes: this.recBytes, total, complete: total > 0 && this.recBytes >= total };
  }

  /** The local blob (the whole file, or the cached prefix) answers a read at `offset`. */
  private localCovers(offset: number): boolean {
    if (this.blob) return true;
    if (!this.prefix) return false;
    return this.prefix.complete || offset < this.prefix.blob.size;
  }
  private localBlob(): Blob {
    return this.blob || this.prefix!.blob;
  }

  start(): void {
    void this.startFetch(0);
  }

  /** Returns the actual (RAP-aligned) time the demuxer will resume from, in seconds. */
  seek(seconds: number): number {
    if (!this.ready) return seconds;
    const r = this.file.seek(Math.max(0, seconds), true);
    if (this.fragmented && seconds > 0.5 && r.time === 0) {
      // Beyond the fragments parsed so far (mp4box answers "time 0"): jump by the segment index.
      const hit = this.sidxLookup(seconds);
      if (hit) {
        this.paused = false;
        this.wake();
        this.cb.onLog(`seek ${seconds.toFixed(2)}s -> fragment at ${hit.time.toFixed(2)}s, file offset ${hit.offset} (sidx)`);
        this.jumpTo(hit.offset);
        return hit.time;
      }
    }
    const total = this.stats.totalBytes;
    const atEof = total > 0 && r.offset >= total;
    this.paused = false;
    this.wake();
    if (this.ended && atEof) {
      // Everything mp4box needs is still in memory: re-emit from the seek point, no network.
      this.cb.onLog(`seek ${seconds.toFixed(2)}s -> RAP at ${r.time.toFixed(2)}s, served from memory (file complete)`);
      this.file.start();
      this.cb.onEnd();
    } else if (!this.ended && r.offset === this.filePos) {
      // The data up to the current download position is in memory; the running fetch continues.
      this.cb.onLog(`seek ${seconds.toFixed(2)}s -> RAP at ${r.time.toFixed(2)}s, served from memory (download continues at ${this.filePos})`);
      this.file.start();
    } else {
      this.cb.onLog(`seek ${seconds.toFixed(2)}s -> RAP at ${r.time.toFixed(2)}s, file offset ${r.offset}`);
      void this.startFetch(r.offset);
    }
    return r.time;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wake();
  }

  destroy(): void {
    this.destroyed = true;
    this.abort?.abort();
    this.wake();
    try {
      this.file.stop();
    } catch {
      /* ignore */
    }
  }

  releaseSamples(trackId: number, uptoSampleNumber: number): void {
    try {
      this.file.releaseUsedSamples(trackId, uptoSampleNumber);
    } catch {
      /* ignore */
    }
  }

  private wake(): void {
    const w = this.resumeWaiters;
    this.resumeWaiters = [];
    w.forEach((fn) => fn());
  }

  /** The fragment (byte offset, start time) holding `seconds`, from the sidx index; undefined without one. */
  private sidxLookup(seconds: number): { offset: number; time: number } | undefined {
    const sidx = (this.file as unknown as { sidx?: { start: number; size: number; timescale: number; earliest_presentation_time: number; first_offset: number; references: { referenced_size: number; subsegment_duration: number }[] } }).sidx;
    if (!sidx?.references?.length || !sidx.timescale) return undefined;
    const target = seconds * sidx.timescale;
    let t = sidx.earliest_presentation_time;
    let offset = sidx.start + sidx.size + sidx.first_offset;
    for (const ref of sidx.references) {
      if (t + ref.subsegment_duration > target) break;
      t += ref.subsegment_duration;
      offset += ref.referenced_size;
    }
    return { offset, time: t / sidx.timescale };
  }

  /**
   * Restarts the download at `offset` (a fragment boundary) and points mp4box's parser there. The
   * samples parsed earlier stay in its tables; extraction continues with the first new fragment.
   */
  private jumpTo(offset: number): void {
    const f = this.file as unknown as {
      lastBoxStartPosition: number;
      nextParsePosition: number;
      parsingMdat?: unknown;
      moov?: { traks: { first_traf_merged?: boolean }[] };
      extractedTracks?: { trak: { nextSample: number; samples: unknown[] }; samples: unknown[] }[];
    };
    f.lastBoxStartPosition = offset;
    f.nextParsePosition = offset;
    f.parsingMdat = undefined;
    // mp4box takes a fragment's tfdt time only for the first fragment it merges and chains every
    // later one onto the previous sample; after a jump the next fragment must start from its tfdt.
    for (const trak of f.moov?.traks || []) trak.first_traf_merged = false;
    for (const t of f.extractedTracks || []) {
      t.trak.nextSample = t.trak.samples.length;
      t.samples = [];
    }
    void this.startFetch(offset);
  }

  private handleReady(info: Movie): void {
    this.ready = true;
    this.fragmented = Boolean(info.isFragmented);
    this.stats.isProgressive = info.isProgressive;
    const v = info.videoTracks?.[0];
    const a = info.audioTracks?.[0];
    this.videoTrack = v ? describeTrack(this.file, v, 'video') : undefined;
    this.audioTrack = a ? describeTrack(this.file, a, 'audio') : undefined;
    this.cb.onLog(
      `moov parsed: ${info.tracks.length} tracks, duration ${(info.duration / info.timescale).toFixed(2)}s, progressive=${info.isProgressive}, fragmented=${info.isFragmented}, brands=${info.brands.join(',')}`,
    );
    if (this.videoTrack) this.file.setExtractionOptions(this.videoTrack.id, undefined, { nbSamples: 30 });
    if (this.audioTrack) this.file.setExtractionOptions(this.audioTrack.id, undefined, { nbSamples: 60 });
    this.file.start();
    this.cb.onReady(info, this.videoTrack, this.audioTrack);
    // Non-progressive files: we may have skipped the mdat to reach moov. Ask mp4box where the
    // first samples live and restart there. (A fragmented file has no samples yet: nothing to ask.)
    if (!info.isProgressive && !this.fragmented) {
      const r = this.file.seek(0, true);
      if (r.offset !== this.filePos) {
        this.cb.onLog(`non-progressive file: restarting download at sample data offset ${r.offset}`);
        void this.startFetch(r.offset);
      }
    }
  }

  /**
   * The local file as if a server had answered the Range request: 206 with the bytes from `offset`
   * (416 at or past the end), so the download loop below needs no second code path.
   */
  private openBlob(offset: number): Response {
    const blob = this.localBlob();
    const type = blob.type || 'video/mp4';
    if (offset >= blob.size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${blob.size}` } });
    const part = offset > 0 ? blob.slice(offset) : blob;
    return new Response(part.stream(), {
      status: offset > 0 ? 206 : 200,
      headers: { 'content-type': type, 'content-length': String(part.size), ...(offset > 0 ? { 'content-range': `bytes ${offset}-${blob.size - 1}/${blob.size}` } : {}) },
    });
  }

  private async startFetch(offset: number): Promise<void> {
    if (this.destroyed) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const gen = ++this.fetchGen;
    this.ended = false;
    if (offset > 0) this.stats.restarts++;
    const headers = new Headers(this.fetchInit?.headers || {});
    if (offset > 0) headers.set('Range', `bytes=${offset}-`);
    let skipBytes = 0;
    const fromLocal = this.localCovers(offset);
    // a prefix read is not recorded (it is the recording's first part already); a network download
    // from byte 0 starts a fresh recording
    if (!fromLocal && offset === 0 && !this.prefix) {
      this.rec = [];
      this.recBytes = 0;
      this.recFrozen = false;
    }
    try {
      const res = fromLocal ? this.openBlob(offset) : await fetch(this.url, { ...(this.fetchInit || {}), headers, signal: ac.signal });
      if (gen !== this.fetchGen) return;
      this.stats.httpStatus = res.status;
      this.stats.contentType = res.headers.get('content-type') || '';
      if (res.status === 416 && offset > 0 && this.stats.totalBytes > 0 && offset >= this.stats.totalBytes) {
        // Asked for bytes at or past EOF: there is nothing left to download.
        this.cb.onLog(`range at EOF (${offset}/${this.stats.totalBytes}); download already complete`);
        this.ended = true;
        this.stats.downloadedTo = this.stats.totalBytes;
        this.file.flush();
        this.cb.onEnd();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching media`);
      const len = Number(res.headers.get('content-length') || 0);
      if (offset > 0) {
        if (res.status === 206) {
          this.stats.rangeSupported = true;
          if (len) this.stats.totalBytes = offset + len;
        } else {
          // Server ignored Range: we must consume and discard the leading bytes.
          this.stats.rangeSupported = false;
          skipBytes = offset;
          if (len) this.stats.totalBytes = len;
          this.cb.onLog(`server ignored Range request (HTTP ${res.status}); discarding ${offset} leading bytes`);
        }
      } else if (len) {
        this.stats.totalBytes = len;
      }
      if (res.status === 206 && offset === 0) this.stats.rangeSupported = true;
      // The cached head is shorter than the file: its Content-Length is not the file's size.
      if (fromLocal && this.prefix && !this.prefix.complete) this.stats.totalBytes = this.prefix.total;
      if (!res.body) throw new Error('Response has no body stream');
      const reader = res.body.getReader();
      this.filePos = offset;
      this.stats.downloadedTo = offset;
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const flushPending = (): boolean => {
        if (!pendingBytes) return true;
        const merged = new Uint8Array(pendingBytes);
        let o = 0;
        for (const p of pending) {
          merged.set(p, o);
          o += p.byteLength;
        }
        pending = [];
        pendingBytes = 0;
        const buf = MP4BoxBuffer.fromArrayBuffer(merged.buffer, this.filePos);
        this.filePos += merged.byteLength;
        this.stats.bytesLoaded += merged.byteLength;
        const next = this.file.appendBuffer(buf);
        this.cb.onProgress(this.stats.bytesLoaded, this.stats.totalBytes);
        // Restart further on only when the wanted position is before EOF; a position at/after the
        // known end means mp4box already holds everything it needs (a Range there would be 416).
        const beforeEof = !this.stats.totalBytes || next < this.stats.totalBytes;
        if (typeof next === 'number' && next > this.filePos && beforeEof && this.stats.rangeSupported !== false) {
          this.cb.onLog(`mp4box requests file position ${next} (skipping ${next - this.filePos} bytes)`);
          void this.startFetch(next);
          return false;
        }
        return true;
      };
      for (;;) {
        if (this.destroyed || gen !== this.fetchGen) return;
        while (this.paused && !this.destroyed && gen === this.fetchGen) {
          await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
        }
        if (this.destroyed || gen !== this.fetchGen) return;
        const { done, value } = await reader.read();
        if (gen !== this.fetchGen) return;
        if (done) {
          if (!flushPending()) return;
          if (fromLocal && this.prefix && !this.prefix.complete && (!this.stats.totalBytes || this.filePos < this.stats.totalBytes)) {
            // The cached head is used up: the rest of the file comes from the network.
            this.cb.onLog(`cached head of ${this.filePos} bytes played; downloading the rest`);
            void this.startFetch(this.filePos);
            return;
          }
          this.ended = true;
          if (!this.stats.totalBytes || this.filePos > this.stats.totalBytes) this.stats.totalBytes = this.filePos;
          this.stats.downloadedTo = this.stats.totalBytes;
          this.file.flush();
          this.cb.onLog(`download complete: ${this.stats.bytesLoaded} bytes`);
          this.cb.onEnd();
          return;
        }
        let chunk = value;
        if (skipBytes > 0) {
          if (chunk.byteLength <= skipBytes) {
            skipBytes -= chunk.byteLength;
            continue;
          }
          chunk = chunk.subarray(skipBytes);
          skipBytes = 0;
        }
        if (!fromLocal && !this.recFrozen) {
          // contiguous from byte 0 (and under the cap): the chunk joins the recording
          if (this.filePos + pendingBytes === this.recBytes && this.recBytes < RECORD_MAX) {
            this.rec.push(chunk);
            this.recBytes += chunk.byteLength;
          } else this.recFrozen = true;
        }
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        this.stats.downloadedTo = this.filePos + pendingBytes;
        if (pendingBytes >= CHUNK_MERGE_TARGET) {
          if (!flushPending()) return;
        }
      }
    } catch (e) {
      if (ac.signal.aborted || gen !== this.fetchGen) return;
      const err = e as Error;
      // A TypeError from fetch() is how the browser reports CORS / network failures: no status is exposed.
      const msg = err.name === 'TypeError' ? `fetch() failed (likely CORS or network): ${err.message}` : err.message;
      this.cb.onError(new Error(msg));
    }
  }
}
