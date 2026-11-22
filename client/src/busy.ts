/**
 * Button feedback: while `work` runs, the pressed button is disabled, gets the `busy` class (spinner via
 * CSS) and optionally shows "<label>…" instead of its text, so the user sees that something is happening
 * and one tap can never fire twice. Works for any button; a second press while busy is ignored.
 * The text comes back when the work is done, unless the work itself gave the button a new one (the
 * account panel's Follow button turns into "Following": putting "Follow" back would undo that).
 */
export function pressed(btn: HTMLButtonElement, work: () => Promise<unknown>, opts: { label?: string; labelEl?: HTMLElement | null } = {}): void {
  if (btn.classList.contains('busy')) return;
  const target = opts.labelEl ?? btn;
  const text = opts.label !== undefined ? target.textContent : null;
  btn.classList.add('busy');
  btn.disabled = true;
  const busyText = opts.label !== undefined ? opts.label + '…' : null;
  if (busyText !== null) target.textContent = busyText;
  void work().finally(() => {
    btn.classList.remove('busy');
    btn.disabled = false;
    if (text !== null && target.textContent === busyText) target.textContent = text;
  });
}
