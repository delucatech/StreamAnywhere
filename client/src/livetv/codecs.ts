/**
 * Which video codecs this browser's decoder handles, and the names the page shows for them.
 *
 * Not every browser decodes H.265 (HEVC): Chrome on Windows / Linux only with a GPU that does it
 * in hardware (none in the car's browser), so an HEVC channel that plays on one device fails on
 * another with "VideoDecoder does not support hev1.…". The answer of VideoDecoder.isConfigSupported
 * for one typical configuration per codec is taken as the browser's word; it is kept per device
 * (localStorage) so the tiles render right from the first paint, and checked again at every start.
 */
import { LIVETV_CODEC_LABEL, type LiveTvCodec } from '../../../shared/types';

const KEY = 'streamanywhere.livetv.decoders';

/** One representative configuration per codec: Main / Baseline profiles at a modest level */
const PROBES: Partial<Record<LiveTvCodec, string[]>> = {
  h264: ['avc1.64001f', 'avc1.42e01e'],
  hevc: ['hev1.1.6.L93.B0', 'hvc1.1.6.L93.B0', 'hev1.2.4.L120.90'],
  av1: ['av01.0.04M.08'],
  vp9: ['vp09.00.10.08'],
};

let decoders: Set<LiveTvCodec> | undefined;
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as string[] | null;
  if (Array.isArray(saved)) decoders = new Set(saved.filter((c): c is LiveTvCodec => c in LIVETV_CODEC_LABEL));
} catch {
  /* no storage */
}

/** The codecs this browser decodes, as last found (undefined before the first check on this device) */
export const knownDecoders = (): Set<LiveTvCodec> | undefined => decoders;

/** Whether this browser decodes `codec`; true when not known yet (nothing is ruled out on a guess) */
export const decodes = (codec: LiveTvCodec | undefined): boolean => !codec || !decoders || decoders.has(codec);

/** Asks the browser's decoder about each codec; resolves with the set, kept on the device. */
export async function detectDecoders(): Promise<Set<LiveTvCodec>> {
  const out = new Set<LiveTvCodec>();
  const VD = (window as unknown as { VideoDecoder?: { isConfigSupported(c: { codec: string }): Promise<{ supported?: boolean }> } }).VideoDecoder;
  if (VD) {
    for (const [codec, strings] of Object.entries(PROBES) as [LiveTvCodec, string[]][]) {
      for (const s of strings) {
        try {
          if ((await VD.isConfigSupported({ codec: s })).supported) {
            out.add(codec);
            break;
          }
        } catch {
          /* a malformed string, or no WebCodecs: not supported */
        }
      }
    }
  } else {
    // no WebCodecs: the <video> fallback plays H.264 everywhere
    out.add('h264');
  }
  decoders = out;
  try {
    localStorage.setItem(KEY, JSON.stringify([...out]));
  } catch {
    /* ignore */
  }
  return out;
}

/** "H.265 (HEVC)" */
export const codecLabel = (codec: LiveTvCodec): string => LIVETV_CODEC_LABEL[codec];
/** The short badge on a tile: "H.265", "AV1", "MPEG-2" */
export const codecBadge = (codec: LiveTvCodec): string => ({ h264: 'H.264', hevc: 'H.265', av1: 'AV1', vp9: 'VP9', mpeg2: 'MPEG-2', mpeg4: 'MPEG-4', other: '?' })[codec];

/** The codec a decoder's error or a track's codec string names ("hev1.2.4.L120.90" -> hevc) */
export function codecOfString(s: string | undefined): LiveTvCodec | undefined {
  const m = /\b(avc1|avc3|hvc1|hev1|dvh1|dvhe|av01|vp09|mp4v|mp2v)\b/i.exec(s || '');
  if (!m) return undefined;
  const t = m[1].toLowerCase();
  if (t === 'avc1' || t === 'avc3') return 'h264';
  if (t === 'hvc1' || t === 'hev1' || t === 'dvh1' || t === 'dvhe') return 'hevc';
  if (t === 'av01') return 'av1';
  if (t === 'vp09') return 'vp9';
  if (t === 'mp2v') return 'mpeg2';
  return 'mpeg4';
}
