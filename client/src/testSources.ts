/**
 * Public MP4 files whose servers were verified (curl with Origin header, 2026-10-08) to return
 * Access-Control-Allow-Origin: * and to honour Range requests. H.264 + AAC, moov position noted.
 */
export interface TestSource {
  id: string;
  label: string;
  url: string;
  note: string;
}

export const TEST_SOURCES: TestSource[] = [
  {
    id: 'rabbit320',
    label: 'MDN rabbit320.mp4 (320p, H.264 + AAC, 0.8 MB)',
    url: 'https://mdn.github.io/learning-area/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4',
    note: 'GitHub Pages: ACAO *, Accept-Ranges bytes',
  },
  {
    id: 'bigbuckbunny',
    label: 'MDN bigbuckbunny.mp4 (H.264 + AAC, 4.7 MB)',
    url: 'https://mdn.github.io/dom-examples/picture-in-picture/assets/bigbuckbunny.mp4',
    note: 'GitHub Pages: ACAO *, Accept-Ranges bytes',
  },
  {
    id: 'flower',
    label: 'MDN flower.mp4 (H.264, 1.1 MB)',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    note: 'GCS-backed: ACAO *, Accept-Ranges bytes',
  },
  {
    id: 'friday',
    label: 'MDN friday.mp4 (H.264, 0.5 MB)',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4',
    note: 'GCS-backed: ACAO *, Accept-Ranges bytes',
  },
];

export const DEFAULT_TIKTOK_URL = 'https://www.tiktok.com/@tiktok/video/7693184538704416031';
