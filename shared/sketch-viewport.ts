/** Read-only geometry bridge for opaque sketch frames; never exposes the Electron API. */
export function injectSketchViewport(html: string): string {
  const bridge = `<script data-bloma-viewport>
(() => {
  let token, pending = 0, viewport = '', last = '';
  const measure = () => {
    pending = 0;
    if (!token || !document.body) return;
    const root = document.documentElement, body = document.body;
    const width = Math.max(1280, root.scrollWidth, body.scrollWidth);
    // The root's scrollHeight is at least the expanded frame height. Ignore that
    // viewport floor so removing content can shrink the document again.
    const height = Math.max(800, body.scrollHeight, body.offsetHeight,
      Math.ceil(body.getBoundingClientRect().bottom + scrollY),
      root.scrollHeight > innerHeight ? root.scrollHeight : 0);
    const next = width + ':' + height;
    if (next === last) return;
    last = next;
    parent.postMessage({ type: 'bloma-viewport-size', token, width, height }, '*');
  };
  const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'bloma-viewport-measure' || typeof event.data.token !== 'string') return;
    token = event.data.token;
    last = '';
    schedule();
  });
  const start = () => {
    viewport = innerWidth + ':' + innerHeight;
    new ResizeObserver(() => {
      const next = innerWidth + ':' + innerHeight;
      // Enlarging the frame must not recursively enlarge layouts expressed in vh/vw.
      if (viewport !== next) { viewport = next; return; }
      schedule();
    }).observe(document.body);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    document.addEventListener('load', schedule, true);
    document.fonts?.ready.then(schedule);
    schedule();
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
</script>`
  // Keep relative resources and all original scripts at their original URL.
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${bridge}</body>`) : html + bridge
}
