/**
 * Stands in for the `qrcode` package in the phone's own viewer page (vite.mirror-local.config.ts):
 * that page is served by the phone over its hotspot and never shows a pairing code, so the encoder
 * would only make the single-file page bigger.
 */
export default {
  toString: async (): Promise<string> => '',
};
