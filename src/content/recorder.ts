// Runs in the Amazon Photos page's own JavaScript world (manifest "world": "MAIN")
// and notes the URL of every photo search the web app makes. The adapter then
// copies the web app's own search parameters instead of guessing them.
// No imports: this file is injected as-is.

(() => {
  const report = (url: string | URL) => {
    const s = String(url);
    // A DOM attribute, not postMessage: the extension's other content script may not be listening yet.
    if (s.includes('/drive/v1/search')) document.documentElement.dataset.apcSearchUrl = new URL(s, location.href).href;
  };

  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    try {
      report(input instanceof Request ? input.url : input);
    } catch {
      // never break the page
    }
    return origFetch.call(this, input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      report(url);
    } catch {
      // never break the page
    }
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
})();
