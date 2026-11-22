/**
 * What this page is waiting for right now: every request to the server that can be slow (api.ts
 * registers them) and every wait a page names itself (a video that is loading or buffering).
 * The status strip (activity.ts) shows the oldest one with its clock and asks the server what it
 * is doing meanwhile, so no wait is a bare spinner.
 */
export interface Wait {
  id: number;
  /** In the viewer's words: "Searching for "tesla"", "Getting the video ready" */
  label: string;
  startedAt: number;
  /**
   * True while nobody is held up by this wait (the next batch while videos play, an upcoming
   * video's address): it does not bring the strip up by itself, and is counted when the strip is
   * up for another wait. Asked each time, since a background wait becomes the viewer's wait when
   * they run out of videos.
   */
  quiet?: () => boolean;
}

/** How a wait is named: a label, or a label with its `quiet` test. */
export type WaitName = string | { label: string; quiet?: () => boolean };

const waits = new Map<number, Wait>();
const listeners = new Set<() => void>();
let nextId = 1;

const changed = (): void => {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a listener's problem is not the waiter's */
    }
  }
};

/** Registers a wait; call the returned function when it is over (calling it twice is fine). */
export function beginWait(name: WaitName): () => void {
  const w: Wait = typeof name === 'string' ? { id: nextId++, label: name, startedAt: Date.now() } : { id: nextId++, label: name.label, startedAt: Date.now(), quiet: name.quiet };
  waits.set(w.id, w);
  changed();
  return () => {
    if (waits.delete(w.id)) changed();
  };
}

/** The waits in flight, oldest first. */
export const currentWaits = (): Wait[] => [...waits.values()].sort((a, b) => a.startedAt - b.startedAt);

/** Whether a wait holds nobody up right now (a throwing test counts as "no": the wait is shown). */
export function isQuiet(w: Wait): boolean {
  try {
    return Boolean(w.quiet?.());
  } catch {
    return false;
  }
}

export function onWaitsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
