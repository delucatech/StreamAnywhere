/**
 * Button feedback: while `work` runs, the pressed button is disabled, gets the `busy` class (spinner via
 * CSS) and optionally shows "<label>…" instead of its text, so the user sees that something is happening
 * and one tap can never fire twice. Works for any button; a second press while busy is ignored.
 */
export function pressed(btn: HTMLButtonElement, work: () => Promise<unknown>, opts: { label?: string; labelEl?: HTMLElement | null } = {}): void {
  if (btn.classList.contains('busy')) return;
  const target = opts.labelEl ?? btn;
  const text = opts.label !== undefined ? target.textContent : null;
  btn.classList.add('busy');
  btn.disabled = true;
  if (opts.label !== undefined) target.textContent = opts.label + '…';
  void work().finally(() => {
    btn.classList.remove('busy');
    btn.disabled = false;
    if (text !== null) target.textContent = text;
  });
}
