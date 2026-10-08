/**
 * Builds WebCodecs decoder configurations from mp4box.js track metadata.
 *
 * VideoDecoder needs the codec string (e.g. avc1.64001f) plus, for avc1/hvc1 style tracks,
 * the raw AVCDecoderConfigurationRecord / HEVCDecoderConfigurationRecord (the avcC/hvcC box
 * payload without its 8-byte box header). AudioDecoder for AAC needs the AudioSpecificConfig
 * carried in the esds DecoderSpecificInfo descriptor.
 */
import { DataStream, Endianness, type ISOFile, type Track } from 'mp4box';

export interface TrackInfo {
  id: number;
  kind: 'video' | 'audio';
  track: Track;
  timescale: number;
  codec: string;
  /** Presentation-time offset (track timescale units) from the first edit list entry */
  editOffset: number;
  durationSec: number;
  nbSamples: number;
  /** Rotation in degrees derived from tkhd matrix (video only) */
  rotation: number;
  width?: number;
  height?: number;
  videoConfig?: VideoDecoderConfig;
  audioConfig?: AudioDecoderConfig;
  configNote?: string;
}

/** Serialises a box and returns its payload (everything after the 8-byte header). */
function boxPayload(box: { write(stream: unknown): void }): Uint8Array {
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  box.write(stream);
  const buf = stream.buffer as ArrayBuffer;
  return new Uint8Array(buf, 8, buf.byteLength - 8);
}

function findDescriptor(desc: any, tag: number, depth = 0): any {
  if (!desc || depth > 6) return undefined;
  if (desc.tag === tag) return desc;
  for (const child of desc.descs || []) {
    const hit = findDescriptor(child, tag, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function editOffsetOf(track: Track): number {
  const edits = (track as any).edits as { media_time: number; segment_duration: number }[] | undefined;
  if (!edits || !edits.length) return 0;
  // An initial empty edit (media_time -1) delays the track; a positive media_time trims the start.
  const first = edits[0];
  return first.media_time > 0 ? first.media_time : 0;
}

function rotationOf(file: ISOFile, trackId: number): number {
  try {
    const trak: any = file.getTrackById(trackId);
    const m: number[] | Int32Array | undefined = trak?.tkhd?.matrix;
    if (!m || m.length < 5) return 0;
    const a = m[0] / 65536;
    const b = m[1] / 65536;
    const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    return ((deg % 360) + 360) % 360;
  } catch {
    return 0;
  }
}

export function describeTrack(file: ISOFile, track: Track, kind: 'video' | 'audio'): TrackInfo {
  const info: TrackInfo = {
    id: track.id,
    kind,
    track,
    timescale: track.timescale,
    codec: track.codec,
    editOffset: editOffsetOf(track),
    durationSec: track.duration / track.timescale,
    nbSamples: track.nb_samples,
    rotation: kind === 'video' ? rotationOf(file, track.id) : 0,
    width: track.video?.width,
    height: track.video?.height,
  };
  const trak: any = file.getTrackById(track.id);
  const entry: any = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  if (kind === 'video') {
    const box = entry?.avcC || entry?.hvcC || entry?.av1C || entry?.vpcC;
    let description: Uint8Array | undefined;
    if (box) {
      try {
        description = boxPayload(box);
      } catch (e) {
        info.configNote = `could not serialise ${box.type || 'config'} box: ${(e as Error).message}`;
      }
    }
    // avc3 / hev1 carry parameter sets in-band; description is optional there.
    const cfg: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.video?.width,
      codedHeight: track.video?.height,
      hardwareAcceleration: 'no-preference',
      optimizeForLatency: false,
    };
    if (description && description.byteLength > 0) cfg.description = description;
    info.videoConfig = cfg;
  } else {
    const cfg: AudioDecoderConfig = {
      codec: track.codec,
      sampleRate: track.audio?.sample_rate || 48000,
      numberOfChannels: track.audio?.channel_count || 2,
    };
    const esds = entry?.esds;
    if (esds?.esd) {
      const dsi = findDescriptor(esds.esd, 5);
      if (dsi?.data && dsi.data.byteLength > 0) cfg.description = dsi.data;
      else info.configNote = 'esds present but no DecoderSpecificInfo; AAC decode may fail';
    } else if (entry?.dOps) {
      // Opus in MP4: description = dOps payload re-framed as OpusHead is optional for WebCodecs
      info.configNote = 'Opus track; relying on in-band headers';
    }
    info.audioConfig = cfg;
  }
  return info;
}

export function shortCodecName(codec: string): string {
  const c = codec.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'H.264';
  if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'H.265/HEVC';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09')) return 'VP9';
  if (c.startsWith('vp08')) return 'VP8';
  if (c.startsWith('mp4a.40')) return 'AAC';
  if (c.startsWith('mp4a')) return 'MPEG audio';
  if (c.startsWith('opus')) return 'Opus';
  return codec;
}
