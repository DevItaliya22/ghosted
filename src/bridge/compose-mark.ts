/** Injects an “Engagement tweet” checkbox into X’s compose toolbar. */
export function watchComposeMark(onChange: (on: boolean) => void) {
  let checked = false;
  const ID = 'ghosted-engagement-mark';

  const sync = (on: boolean) => {
    if (checked === on) return;
    checked = on;
    onChange(on);
  };

  const mount = (toolbar: Element) => {
    if (toolbar.querySelector(`#${ID}`)) return;
    const label = document.createElement('label');
    label.id = ID;
    label.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;margin-right:12px;font:12px -apple-system,BlinkMacSystemFont,sans-serif;color:#e7e9ea;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.style.cssText = 'width:14px;height:14px;accent-color:#1d9bf0;cursor:pointer';
    input.addEventListener('change', () => sync(input.checked));
    label.append(input, document.createTextNode('Engagement tweet'));
    const btn =
      toolbar.querySelector('[data-testid="tweetButtonInline"]') ??
      toolbar.querySelector('[data-testid="tweetButton"]');
    if (btn?.parentElement) btn.parentElement.insertBefore(label, btn);
    else toolbar.appendChild(label);
  };

  const scan = () => {
    for (const bar of document.querySelectorAll('[data-testid="toolBar"]')) mount(bar);
  };

  scan();
  const obs = new MutationObserver(scan);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  return () => obs.disconnect();
}
