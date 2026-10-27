/**
 * Stereo downmix for the channel layouts Web Audio cannot fold by itself.
 *
 * Web Audio folds mono, stereo, quad and 5.1 into the stereo output with its "speakers" rules
 * (5.1: L + 0.707·C + 0.707·SL, LFE dropped). Any other count is mixed "discretely": the output
 * keeps the first two channels and drops the rest, so a 7.1 film lost its centre channel, where
 * the dialogue is. Those layouts are mixed here, before the buffer reaches Web Audio, with the
 * same loudness as Web Audio's own 5.1 rule.
 *
 * Channel order: WAVE / SMPTE, the order Web Audio itself uses for 5.1 and the order Chrome's
 * decoders hand out (L R C LFE, then the surround channels in left/right pairs).
 */

const H = Math.SQRT1_2;

/** True when Web Audio would mix this many channels discretely (losing all but the first two). */
export function needsStereoDownmix(channels: number): boolean {
  return channels > 2 && channels !== 4 && channels !== 6;
}

/** [left, right] gain for each input channel. */
export function stereoGains(channels: number): Array<[number, number]> {
  switch (channels) {
    case 3: // 3.0: L R C
      return [[1, 0], [0, 1], [H, H]];
    case 5: // 5.0: L R C SL SR
      return [[1, 0], [0, 1], [H, H], [H, 0], [0, H]];
    case 7: // 6.1: L R C LFE BC SL SR; back centre and side share the surround's 0.707, like 7.1
      return [[1, 0], [0, 1], [H, H], [0, 0], [0.5, 0.5], [0.5, 0], [0, 0.5]];
    case 8: // 7.1: L R C LFE BL BR SL SR; back and side share the surround's 0.707 (power 0.5 + 0.5)
      return [[1, 0], [0, 1], [H, H], [0, 0], [0.5, 0], [0, 0.5], [0.5, 0], [0, 0.5]];
  }
  // Anything else: L R C, LFE (when there are at least six channels) dropped, the rest in left/right pairs
  // sharing the surround's 0.707; an odd one out goes to both sides.
  const gains: Array<[number, number]> = [[1, 0], [0, 1], [H, H]];
  const firstSurround = channels >= 6 ? 4 : 3;
  if (channels >= 6) gains.push([0, 0]);
  const rest = channels - firstSurround;
  const pairs = Math.ceil(rest / 2);
  const g = pairs ? H / Math.sqrt(pairs) : 0;
  for (let i = 0; i < rest; i++) {
    if (rest % 2 === 1 && i === rest - 1) gains.push([g * H, g * H]);
    else gains.push(i % 2 === 0 ? [g, 0] : [0, g]);
  }
  return gains.slice(0, channels);
}

/** Mixes the planes (one Float32Array per channel, `frames` samples each) into a stereo pair. */
export function mixToStereo(planes: Float32Array[], frames: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const gains = stereoGains(planes.length);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let ch = 0; ch < planes.length; ch++) {
    const [gl, gr] = gains[ch];
    const p = planes[ch];
    if (gl) for (let i = 0; i < frames; i++) left[i] += gl * p[i];
    if (gr) for (let i = 0; i < frames; i++) right[i] += gr * p[i];
  }
  return [left, right];
}
