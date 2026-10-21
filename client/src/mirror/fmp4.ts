/**
 * A small fragmented-MP4 writer for Media Source Extensions: one init segment (ftyp + moov, with the
 * H.264 and AAC-LC tracks declared from the Mirror CONFIG) and then one moof + mdat per frame.
 *
 * MSE is the viewer's fallback decoder: the phone's own page on the hotspot is plain http, where
 * WebCodecs does not exist (it needs a secure context), while <video> + MediaSource works anywhere.
 * Per-frame fragments keep the delay to a few frames.
 */
import { base64ToBytes, type MirrorAudioConfig, type MirrorVideoConfig } from '../../../shared/mirror';

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
export const VIDEO_TIMESCALE = 90000;

class Writer {
  private parts: Uint8Array[] = [];
  private size = 0;
  push(b: Uint8Array): void {
    this.parts.push(b);
    this.size += b.byteLength;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }
}

const str = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const u8 = (...v: number[]): Uint8Array => new Uint8Array(v);
const u16 = (v: number): Uint8Array => u8((v >> 8) & 0xff, v & 0xff);
const u24 = (v: number): Uint8Array => u8((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
const u32 = (v: number): Uint8Array => u8((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const u64 = (v: number): Uint8Array => {
  const hi = Math.floor(v / 0x100000000);
  return new Uint8Array([...u32(hi), ...u32(v >>> 0)]);
};
const fixed16 = (v: number): Uint8Array => u32(Math.round(v * 65536));

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  let size = 8;
  for (const c of children) size += c.byteLength;
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(str(type), 4);
  let o = 8;
  for (const c of children) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
const fullBox = (type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array => box(type, u8(version), u24(flags), ...children);

const UNITY_MATRIX = new Uint8Array([...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)]);

function tkhd(trackId: number, width: number, height: number, audio: boolean): Uint8Array {
  return fullBox(
    'tkhd',
    0,
    3, // enabled + in movie
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(0), // duration (unknown)
    u32(0),
    u32(0), // reserved
    u16(0), // layer
    u16(audio ? 1 : 0), // alternate group
    u16(audio ? 0x0100 : 0), // volume
    u16(0),
    UNITY_MATRIX,
    fixed16(width),
    fixed16(height),
  );
}

function mdhd(timescale: number): Uint8Array {
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4) /* "und" */, u16(0));
}

const hdlr = (kind: 'vide' | 'soun', name: string): Uint8Array => fullBox('hdlr', 0, 0, u32(0), str(kind), u32(0), u32(0), u32(0), str(name), u8(0));

const dinf = (): Uint8Array => box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

function emptyStbl(stsd: Uint8Array): Uint8Array {
  return box('stbl', stsd, fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
}

function avc1(v: MirrorVideoConfig): Uint8Array {
  const avcC = box('avcC', base64ToBytes(v.description));
  const compressor = new Uint8Array(32); // 1 length byte + 31 chars
  return box(
    'avc1',
    u8(0, 0, 0, 0, 0, 0), // reserved
    u16(1), // data reference index
    u16(0),
    u16(0), // pre-defined, reserved
    u32(0),
    u32(0),
    u32(0), // pre-defined
    u16(v.width),
    u16(v.height),
    u32(0x00480000), // 72 dpi
    u32(0x00480000),
    u32(0),
    u16(1), // frame count
    compressor,
    u16(0x0018), // depth
    u16(0xffff), // pre-defined
    avcC,
  );
}

function esds(a: MirrorAudioConfig): Uint8Array {
  const asc = base64ToBytes(a.description);
  const dsi = new Uint8Array([0x05, asc.byteLength, ...asc]);
  const dcd = new Uint8Array([
    0x04,
    13 + dsi.byteLength,
    0x40, // AAC
    0x15, // audio stream
    0,
    0,
    0, // buffer size
    ...u32(128000), // max bitrate
    ...u32(128000), // avg bitrate
    ...dsi,
  ]);
  const sl = new Uint8Array([0x06, 0x01, 0x02]);
  const es = new Uint8Array([0x03, 3 + dcd.byteLength + sl.byteLength, 0, 0, 0, ...dcd, ...sl]);
  return fullBox('esds', 0, 0, es);
}

function mp4a(a: MirrorAudioConfig): Uint8Array {
  return box(
    'mp4a',
    u8(0, 0, 0, 0, 0, 0),
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u16(a.channels),
    u16(16), // sample size
    u16(0),
    u16(0),
    u32(a.sampleRate << 16),
    esds(a),
  );
}

function trak(video?: MirrorVideoConfig, audio?: MirrorAudioConfig): Uint8Array {
  if (video) {
    return box(
      'trak',
      tkhd(VIDEO_TRACK, video.width, video.height, false),
      box('mdia', mdhd(VIDEO_TIMESCALE), hdlr('vide', 'Mirror video'), box('minf', fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf(), emptyStbl(fullBox('stsd', 0, 0, u32(1), avc1(video))))),
    );
  }
  const a = audio!;
  return box(
    'trak',
    tkhd(AUDIO_TRACK, 0, 0, true),
    box('mdia', mdhd(a.sampleRate), hdlr('soun', 'Mirror audio'), box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), dinf(), emptyStbl(fullBox('stsd', 0, 0, u32(1), mp4a(a))))),
  );
}

const trex = (trackId: number): Uint8Array => fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));

/** ftyp + moov for the declared tracks. */
export function initSegment(video?: MirrorVideoConfig, audio?: MirrorAudioConfig): Uint8Array {
  const w = new Writer();
  w.push(box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso5'), str('avc1'), str('mp41')));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY_MATRIX, new Uint8Array(24), u32(0xffffffff));
  const traks: Uint8Array[] = [];
  const trexes: Uint8Array[] = [];
  if (video) {
    traks.push(trak(video));
    trexes.push(trex(VIDEO_TRACK));
  }
  if (audio) {
    traks.push(trak(undefined, audio));
    trexes.push(trex(AUDIO_TRACK));
  }
  w.push(box('moov', mvhd, ...traks, box('mvex', ...trexes)));
  return w.bytes();
}

/** The MIME type of the SourceBuffer for these tracks. */
export function mimeType(video?: MirrorVideoConfig, audio?: MirrorAudioConfig): string {
  const codecs = [video?.codec, audio?.codec].filter(Boolean).join(', ');
  return `video/mp4; codecs="${codecs}"`;
}

/** One frame as moof + mdat. `decodeTime` and `duration` in the track's timescale. */
export function mediaSegment(kind: 'video' | 'audio', seq: number, decodeTime: number, duration: number, key: boolean, data: Uint8Array): Uint8Array {
  const trackId = kind === 'video' ? VIDEO_TRACK : AUDIO_TRACK;
  // sample flags: a keyframe depends on nothing; anything else depends on others and is not a sync sample
  const flags = kind === 'audio' || key ? 0x02000000 : 0x01010000;
  const trunBody = (dataOffset: number): Uint8Array => fullBox('trun', 0, 0x001 | 0x100 | 0x200 | 0x400, u32(1), u32(dataOffset), u32(duration), u32(data.byteLength), u32(flags));
  const trafBody = (trun: Uint8Array): Uint8Array => box('traf', fullBox('tfhd', 0, 0x020000, u32(trackId)), fullBox('tfdt', 1, 0, u64(decodeTime)), trun);
  const mfhd = fullBox('mfhd', 0, 0, u32(seq));
  // the data offset is relative to the start of the moof: moof size + 8 (the mdat header)
  const probe = box('moof', mfhd, trafBody(trunBody(0)));
  const moof = box('moof', mfhd, trafBody(trunBody(probe.byteLength + 8)));
  const mdat = box('mdat', data);
  const out = new Uint8Array(moof.byteLength + mdat.byteLength);
  out.set(moof, 0);
  out.set(mdat, moof.byteLength);
  return out;
}
