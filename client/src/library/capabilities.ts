/**
 * What this browser can do with video files, decided once per page load. The library shows only the
 * actions that work here:
 *
 *  - The car (Tesla's browser) has no file downloads at all: nothing can be saved on the device, so
 *    only "Download for in-app playback" (IndexedDB) is offered there.
 *  - iPhone / iPad: `<a download>` saves a file into the Files app ("Downloads"); the share sheet
 *    (Web Share with files) can also put it into Photos. No destination picker.
 *  - Desktop Chromium / Edge: `showSaveFilePicker` lets the user choose the destination; others
 *    save into the browser's download folder.
 *  - IndexedDB holds the in-app copies everywhere; `navigator.storage.persist()` asks the browser
 *    not to evict them (Safari on iPhone may still clear site data after 7 days without a visit
 *    unless the app is on the Home Screen).
 */
const ua = navigator.userAgent;

export const isTesla = /Tesla\//i.test(ua) || /QtCarBrowser/i.test(ua);
export const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isSafari = /Safari\//.test(ua) && !/Chrom(e|ium)\/|Edg\//.test(ua);
/** Opened from the Home Screen (iOS) or installed (Chromium): storage is treated as more durable */
export const isStandalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export const hasIndexedDb = typeof indexedDB !== 'undefined';
/** Files can be saved on this device at all */
export const canSaveFiles = !isTesla;
/** The user can pick where the file goes (File System Access API; Chromium desktop) */
export const canPickDestination = canSaveFiles && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function' && !isIOS;
/** The share sheet accepts files (iPhone: "Save to Files", "Save Video" into Photos) */
export const canShareFiles = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean | undefined;
}

export async function storageInfo(): Promise<StorageInfo> {
  let usage = 0;
  let quota = 0;
  let persisted: boolean | undefined;
  try {
    const e = await navigator.storage?.estimate?.();
    usage = e?.usage || 0;
    quota = e?.quota || 0;
  } catch {
    /* no estimate on this browser */
  }
  try {
    persisted = await navigator.storage?.persisted?.();
  } catch {
    persisted = undefined;
  }
  return { usage, quota, persisted };
}

/** Asks the browser to keep this site's storage; false when it would not say yes (or has no such API). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

/** One short line about how durable local downloads are on this browser (shown in the storage footer). */
export function persistenceNote(persisted: boolean | undefined): string {
  if (isTesla) return 'The car keeps these videos until its browser data is cleared; they are not synced anywhere.';
  if (isIOS && !isStandalone) return 'Safari may delete them after 7 days without a visit; adding the app to the Home Screen keeps them longer.';
  if (persisted) return 'Kept until you delete them (the browser granted persistent storage).';
  if (persisted === false) return 'The browser may clear them when space runs low.';
  return 'Kept as long as the browser keeps site data.';
}
