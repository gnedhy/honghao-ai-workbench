// Runs inside the browser. Driver polling and assertions are outside the measured interval.
export function observeDOMMeasurement({ trigger, event, selector, count, text, property }) {
  window[property] = null;
  const start = () => {
    const began = trigger ? performance.now() : 0;
    let queued = false;
    const matches = () => {
      const rows = document.querySelectorAll(selector);
      return rows.length === count && (!text || (rows[0]?.textContent + ' ' + rows[0]?.getAttribute('aria-label')).includes(text));
    };
    const probe = () => {
      if (queued || !matches()) return;
      queued = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        queued = false;
        if (matches()) {
          window[property] = performance.now() - began;
          observer.disconnect();
        }
      }));
    };
    const observer = new MutationObserver(probe);
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    probe();
  };
  if (trigger) {
    const element = document.querySelector(trigger);
    if (!element) throw new Error('Missing performance trigger');
    element.addEventListener(event, start, { capture: true, once: true });
  } else start();
}
