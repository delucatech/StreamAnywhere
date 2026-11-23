/**
 * What this page is waiting for right now: every request to the server that can be slow (api.ts
 * registers them) and every wait a page names itself (a video that is loading or buffering).
 * The status line (activity.ts) shows the oldest one - one short line with its clock - so no wait
 * is a bare spinner.
 */

/** The facts of a wait that change while it lasts, asked at every repaint of the status line. */
export interface WaitInfo {
  /** Replaces the wait's label while it applies ("Buffering") */
  label?: string;
  /** [step, of]: shown as "step 2 of 3" */
  step?: [number, number];
  /** What is moving right now, in a few words: "1.2 MB of 14.0 MB", "asking YouTube" */
  detail?: string;
  /** The server's side of the wait right now (see Wait.route); undefined = none at this moment */
  route?: string;
  ref?: string;
}

export interface Wait {
  id: number;
  /** In the viewer's words: "Searching for "tesla"", "Getting the video ready" */
  label: string;
  startedAt: number;
  /**
   * True while nobody is held up by this wait (the next batch while videos play, an upcoming
   * video's address): it never shows on the status line. Asked each time, since a background wait
   * becomes the viewer's wait when they run out of videos.
   */
  quiet?: () => boolean;
  /** The moving facts (step, bytes); see WaitInfo */
  info?: () => WaitInfo | undefined;
  /**
   * The server's work for this wait: the activity of the same request ("POST /api/resolve") and,
   * when both sides name one, the same `ref` (the video's address). Its current step is the
   * line's detail.
   */
  route?: string;
  ref?: string;
}

/** How a wait is named: a label, or a label with its options. */
export type WaitName = string | { label: string; quiet?: () => boolean; info?: () => WaitInfo | undefined; route?: string; ref?: string };

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
  const w: Wait = typeof name === 'string' ? { id: nextId++, label: name, startedAt: Date.now() } : { id: nextId++, label: name.label, startedAt: Date.now(), quiet: name.quiet, info: name.info, route: name.route, ref: name.ref };
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

/** The moving facts of a wait right now (a throwing source counts as none). */
export function infoOf(w: Wait): WaitInfo {
  try {
    return w.info?.() || {};
  } catch {
    return {};
  }
}

export function onWaitsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
