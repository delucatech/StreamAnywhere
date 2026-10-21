/** Chrome's MediaStreamTrackProcessor (not in TypeScript's DOM library yet): audio samples from a track. */
interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}
declare class MediaStreamTrackProcessor<T = AudioData | VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}
