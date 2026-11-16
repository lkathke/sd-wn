// The declarative content_scripts in manifest.json only fire on a real navigation
// (document_start/document_idle) — a client-side route change into "/dashboard/live/*" (e.g. the
// app redirecting via history.pushState right after login, instead of a full page load) never
// triggers them. Confirmed live: after such a redirect, bridge.js/overlay.js never ran at all (no
// GraphQL harvest, no shipping profiles, no Stream Deck bridge connection) until the seller
// manually reloaded the page or opened a new tab. This listener re-injects both scripts whenever a
// same-document ("SPA") navigation lands on a matching URL, so that manual step is no longer
// needed. Both scripts guard against running twice in the same document (see
// window.__wnBridge/__wnOverlayLoaded), so this is safe even if it ever fires for a URL the
// declarative content_scripts already handled.
const LIVE_DASHBOARD_RE = /^https:\/\/www\.whatnot\.com\/[^/]+\/dashboard\/live\//;

chrome.webNavigation.onHistoryStateUpdated.addListener(
  async (details) => {
    if (details.frameId !== 0 || !LIVE_DASHBOARD_RE.test(details.url)) return;
    try {
      // MAIN world first, same order/worlds as manifest.json's content_scripts — bridge.js patches
      // window.fetch/WebSocket before overlay.js starts relying on them.
      await chrome.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        files: ["src/bridge.js"],
        world: "MAIN",
        injectImmediately: true,
      });
      await chrome.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        files: ["src/overlay.js"],
        world: "ISOLATED",
      });
    } catch (err) {
      console.warn("[Whatnot Helper] Re-injection nach SPA-Navigation fehlgeschlagen:", err);
    }
  },
  { url: [{ hostEquals: "www.whatnot.com" }] }
);
