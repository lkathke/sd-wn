# Whatnot Stream Deck Controller

Physical macro-deck control for running live [Whatnot](https://www.whatnot.com) auctions
(start price, shipping method, auction duration, starting the auction) without alt-tabbing to the
browser mid-show.

## Architecture

Two independent packages, talking over a local WebSocket:

```
Stream Deck app (Elgato)                Chrome (whatnot.com tab)
  └─ streamdeck-plugin/  ──ws://localhost:9271──  whatnot-helper/ (unpacked extension)
     (Node.js process)                              ├─ bridge.js   (MAIN world)
                                                      └─ overlay.js (ISOLATED world)
```

- **streamdeck-plugin/** — the actual Stream Deck plugin (`@elgato/streamdeck` SDK v2, TypeScript,
  Rollup build). Runs as a Node.js child process launched by the Stream Deck app. Starts a
  `ws` WebSocket server on port **9271** that the Chrome extension connects to.
- **whatnot-helper/** — unpacked Chrome extension (Manifest V3), loaded via
  `chrome://extensions` → "Load unpacked" (not published anywhere). Two content scripts:
  - `bridge.js` (`world: "MAIN"`, `document_start`) — patches `window.fetch` to harvest the
    Whatnot web app's own GraphQL requests (URL + headers + query text), and patches
    `WebSocket.prototype.send` to piggyback on the app's own Phoenix auction socket. This is how
    we read/write listings, shipping profiles, and start auctions **without our own auth** — we
    reuse whatever session the logged-in seller already has. The socket multiplexes **two
    topics** on one connection — `commerce:<livestreamId>` (`start_auction`, `pin_product`) and
    `auction:<livestreamId>` (`start_giveaway`, `select_giveaway_winner`) — each with its own
    `joinRef`, tracked in `state.channels`; `push(channel, event, payload)` picks the right one.
    Broadcast frames matching `FORWARDED_EVENTS` (the `giveaway_*` events) get relayed to
    `overlay.js` via `postMessage({ __wn: 'event', ... })` instead of only handling `phx_reply`s,
    since giveaway progress has no polling endpoint. See the big comment block at the top of
    `bridge.js` for the full GraphQL/Phoenix protocol details (operation names, message shape,
    etc.) — it's substantial and lives there, not duplicated here.
  - `overlay.js` (`world: "ISOLATED"`, `document_idle`) — draws a small control bar into a Shadow
    DOM on the live-dashboard page (current listing, price, shipping, duration, bump, auction
    mode, a two-step "Auktion starten"/"Giveaway starten" button that switches on the selected
    listing's `transactionType`, plus a "Gewinner ziehen" button enabled while a giveaway is
    live), and separately opens the WebSocket connection to the Stream Deck plugin
    (`ws://localhost:9271`), translating incoming commands into UI state changes / calls into
    `bridge.js` via a `postMessage` RPC (`call(method, ...args)`).

**Why this two-script split**: MAIN world is required to reach `window.fetch`/`WebSocket` and
`window.__APOLLO_CLIENT__`; a normal (isolated) content script can't touch page globals. The UI
lives in ISOLATED world instead because MAIN-world scripts shouldn't own long-lived DOM/WebSocket
state that needs `chrome.*` APIs later.

## WebSocket bridge protocol (port 9271)

Defined in `streamdeck-plugin/src/bridge/ws-server.ts`. Four message shapes, all JSON:

1. **One-way commands**, plugin → extension (`broadcastCommand()`), no reply expected:
   `{ type: "setStartPrice" | "setShippingMethod" | "setAuctionDuration" | "selectListing" | "startAuction" | "setAuctionMode" | "startGiveaway" | "drawGiveawayWinner", ... }`.
   Handled in `overlay.js`'s `handleCommand()`.
2. **Requests**, plugin → extension, reply expected (`requestFromExtension()` in `ws-server.ts`,
   `handleRequest()` in `overlay.js`): `{ type, requestId, ... }` → extension replies
   `{ type: "response", requestId, ok, result | error }`. Used so a Property Inspector can pull
   live data (shipping profiles, listings) through the plugin from the browser. Distinguished from
   commands purely by the presence of `requestId`.
3. **Overlay state reports**, extension → plugin, one-way, no reply: `{ type: "overlayState",
   priceCents?, shippingLabel?, mode? }`. Sent by `overlay.js`'s `sendOverlayState()` (debounced via
   an equality check against the last-sent payload) whenever the user edits the browser bar
   directly rather than pressing a Stream Deck key — `applyOverlayState()` in `ws-server.ts` mirrors
   it into the same `state/*` global settings a key press would write, so Current Price/Shipping
   Display and Toggle Sudden Death stay correct either direction. Only sent for auction listings
   (giveaways have no price/shipping/mode); resent on (re)connect so a fresh plugin process picks
   up whatever the bar already shows instead of waiting for the next edit.
   Duration is deliberately excluded from this sync — there's no "Current Duration Display" key,
   so nothing on the deck consumes it.
4. Connection status is tracked in `streamdeck-plugin/src/bridge/connection-status.ts` (pub/sub) —
   every action's rendered title/image gets a `⚠` prefix when no extension client is connected, so
   a press fails visibly instead of silently.

**Listing list cache is incomplete** — `bridge.js`'s `getListings()` only returns whatever fields
the Whatnot dashboard's own listing-list GraphQL query already put in the Apollo cache, and that
query does **not** reliably include `shippingProfile` (confirmed live: a real listing had `price`
populated but no `shippingProfile` key at all on the `ListingNode`). `overlay.js`'s
`ensureListingDetails()` works around this by lazily fetching the fuller `GetSellerLiveListing`
shape via `bridge.js`'s `getListingDetails` (a thin wrapper around `readListing()`) for the
currently selected listing, and preferring that over the list cache's `shippingProfile` field when
rendering/starting.

**Tried and confirmed not to work: self-authoring a minimal replacement query.** A tempting
shortcut — since `readListing()` needs the app to have sent the exact `GetSellerLiveListing`
operation at least once (its query text is only ever harvested, never guessed at), we tried
hand-authoring a tiny standards-based substitute instead: Relay's standard `node(id: ID!): Node`
root field selecting only `shippingProfile { id name }` (a field selection already proven valid,
since `M_UPDATE`'s own mutation response asks for exactly that). It failed live with a **400 Bad
Request** — and the response made the reason clear: the POST URL Whatnot's endpoint expects carries
`?operationName=<name>&ssr=0`, which comes from whatever URL got harvested (baked in at harvest
time, not reconstructed per call), so our custom operation name in the request body never matched
the URL's `operationName` param. That strongly suggests an operation allowlist/persisted-queries
setup on the server side — arbitrary self-authored query documents aren't accepted even when their
field selection is valid. **Conclusion: don't retry this approach** — harvesting the real operation
from the app remains the only path for anything `readListing()` needs.

`readListing()`'s dependency on a harvested `GetSellerLiveListing` is real for both
`ensureListingDetails()` and `patchListing()` (used by `Set Start Price`/`Set Shipping Method`,
which need the *entire* current listing to safely round-trip the replace-only `UpdateListing`
mutation) — both can fail this way until the app has fired that query once (e.g. by opening a
listing's "Produktaktionen"). `ensureListingDetails()` retries on a 4s cooldown
(`listingDetailsFailedId`/`listingDetailsFailedAt` in `overlay.js`) instead of giving up
permanently, so it self-heals within seconds once the harvest lands, without a page reload.

Same underlying startup race also existed in `getShippingProfiles()`'s custom-profiles
pagination loop (no fallback query, no `.catch()`) — an early failure there used to throw all the
way up through `overlay.js`'s init IIFE as an unhandled rejection and silently prevent
`setInterval(refresh, ...)` from ever starting, freezing the whole bar until a reload. Fixed by
wrapping that loop in try/catch (fail soft to an empty list, matching the suggested-profiles
branch's existing `.catch(() => [])`) and moving the retry into `overlay.js`'s
`ensureProfilesLoaded()`, called every `refresh()` cycle on the same cooldown pattern.

**`shippingProfile` sits under `product` in `GetSellerLiveListing`'s response shape, not at the
top level** — confirmed live via a temporary diagnostic log in `readListing()`. This was a real
bug, not just a display gap: `toListingInput()`'s default (`shippingProfileId: l.shippingProfile
?.id ?? null`, `l` being `readListing()`'s result) always read `undefined` from the wrong path, so
**every `patchListing()` call that didn't explicitly set a shipping profile silently cleared it** —
since `UpdateListing` replaces the whole listing rather than merging, every `Set Start Price` press
was quietly wiping whatever shipping profile was already set. Fixed to prefer `l.product
?.shippingProfile?.id`, falling back to the old top-level path for safety. `overlay.js`'s
`ensureListingDetails()`-based prefill/display had the identical bug (`listingDetails.shippingProfile`
→ `listingDetails.product.shippingProfile`), fixed the same way.

**Duration/bump/mode have no server-side per-listing storage** — unlike price and shipping, they're
not fields on the listing at all; Whatnot only accepts them as parameters of the `start_auction`
push itself. `overlay.js` fakes "per-listing memory" for them client-side: `saveListingPref()`/
`applyListingPrefs()` read and write a `{ [listingId]: { durationSeconds, bumpSeconds, mode } }` map
in `localStorage` (key `wn-helper:listingPrefs`, shared with whatnot.com's own storage under our
own namespaced key — harmless). Every path that changes one of these three fields — the bar's own
`change` listeners, and the Stream Deck `setAuctionDuration`/`setAuctionMode` commands — writes
back into this map; every path that changes the *selected listing* — the bar's `listing` `change`
listener, the initial load, and the `selectListing` command — reads it back out before `render()`.

## Stream Deck actions (all UUID-prefixed `com.lkathke.whatnot-controller.*`)

| Action | File | What it does |
|---|---|---|
| Set Start Price | `set-start-price.ts` | Fixed preset price key. Configurable bg/text color. |
| Adjust Start Price | `adjust-start-price.ts` | +/- a configurable delta. **Long-press** (>500ms) switches to a bigger configurable `holdDelta` and repeats every 500ms while held (see `onKeyDown`/`onKeyUp` + `HOLD_THRESHOLD_MS`/`REPEAT_INTERVAL_MS`). |
| Current Price Display | `current-price-display.ts` | Read-only, shows the shared current price, flashes red text on change. Press resets to a configurable default price. |
| Set Shipping Method | `set-shipping-method.ts` | Fixed preset shipping key. PI dropdown is populated live from the seller's real profiles (`onSendToPlugin` → `requestFromExtension`), not hardcoded. |
| Current Shipping Display | `current-shipping-display.ts` | Same pattern as price display. **Also doubles as the config UI** for the shared shipping order/enabled list (see below) since that's global config with no single natural home. |
| Adjust Shipping Method | `adjust-shipping-method.ts` | ◀/▶ steps through the **configured, enabled-only, ordered** shipping list (`state/shipping-order.ts`), not the raw unordered API list. |
| Shipping Picker Slot/Nav | `shipping-picker-slot.ts` / `-nav.ts` | Grid-picker pattern: place N slot keys (0-based `slot` index) + 1-2 nav keys inside a native Stream Deck **Folder** (see below for why it must be a Folder) to page through all shipping profiles, 13/page. |
| Article Picker Slot/Nav | `article-picker-slot.ts` / `-nav.ts` | Same grid pattern for live listings, attempts to show the product thumbnail via `setImage()`. **Unverified**: the exact image-URL field in `bridge.js`'s `getListings()` output has never been confirmed against a real listing with images — `extractImageUrl()` guesses common field names and falls back to text-only. |
| Set Auction Duration | `set-auction-duration.ts` | Fixed preset duration key. |
| Cycle Auction Duration | `cycle-auction-duration.ts` | One key cycles through a configurable comma-separated duration list on each press; position persisted in its own (not global) settings. |
| Start Auction | `start-auction-button.ts` | Sends `{type:"startAuction"}` — the extension starts the auction using whatever the **browser overlay** currently has selected (listing/price/shipping/duration/bump/mode), skipping the overlay's own two-step confirm (a dedicated physical key doesn't need it the way a hover-prone web button does). |
| Toggle Sudden Death | `toggle-sudden-death.ts` | Flips the shared `currentAuctionMode` (`state/auction-mode.ts`) between `"standard"` and `"suddenDeath"` and broadcasts `setAuctionMode`, which sets the overlay's mode `<select>` — read by Start Auction at the *next* start, not a live auction. Key itself is the display (red when armed); no separate display tile since Start Auction is the only other consumer. **Reverse/Dutch auction is deliberately not exposed** — it's behind a feature flag in the app and the native UI doesn't offer it either, so the overlay only ever sends `isDutchAuction: false`. |
| Start Giveaway | `start-giveaway-button.ts` | Sends `{type:"startGiveaway"}` — pins the overlay's selected listing (`pin_product` on the `commerce` topic, required or nobody can enter) then pushes `start_giveaway` on the `auction` topic. The listing must already be configured as a giveaway in the browser (see `configureGiveaway()` in `bridge.js`) — the push carries only the product UUID, no config. |
| Draw Giveaway Winner | `draw-giveaway-winner-button.ts` | Sends `{type:"drawGiveawayWinner"}` — same `select_giveaway_winner` push the browser's "Draw Winner"/"End Giveaway" button uses (same call either way; the server decides which it means based on entry count). |

**Giveaway duration is not controllable** — Whatnot gives it a fixed 5-minute window server-side
(`giveaway.giveawayEndTime`) with no duration field anywhere in the push or the listing config;
the only lever is ending it early via Draw Giveaway Winner.

## Global vs. per-key state

Two categories, don't confuse them:

- **Global** (`streamDeck.settings.getGlobalSettings/setGlobalSettings`, plugin-wide):
  - `currentPriceCents` (`state/current-price.ts`) — clamped to a **1€ minimum** (`MIN_PRICE_CENTS`
    in that file) since Whatnot rejects 0€ starts. `setCurrentPriceCents()` returns the *clamped*
    value — always broadcast that, never the raw requested value.
  - `currentShippingLabel` (`state/current-shipping.ts`)
  - `shippingOrder: {name, enabled}[]` (`state/shipping-order.ts`) — user-configured via Current
    Shipping Display's PI (checkbox + ▲/▼ reorder buttons, auto-saves on every change via
    `sendToPlugin`/`setShippingOrderConfig`). `getEnabledShippingOrder()` falls back to the raw
    live profile list (unfiltered) until the user has configured anything.
  - `currentAuctionMode` (`state/auction-mode.ts`) — `"standard" | "suddenDeath"`, defaults to
    `"standard"`. Not stored anywhere on Whatnot's side (it's a boolean sent fresh with every
    `start_auction` push); this is just the plugin's own memory of what Toggle Sudden Death last
    set, mirrored to the overlay's mode select.
- **Per-key** (normal Stream Deck settings, via each action's Property Inspector): everything else
  — preset values, colors, slot indices, delta amounts, `CycleAuctionDuration`'s own
  `currentIndex`.

## Rendering: everything is a self-drawn SVG, not native title+icon

Stream Deck's built-in title overlay can't be recolored/backgrounded per call, so every action
that needs a background color, custom text color, or flash-on-change effect draws its **entire**
key image as an SVG data URI (`data:image/svg+xml,${encodeURIComponent(svg)}`) via `setImage()`,
with `setTitle("")` to blank the native title. All of this lives in
`streamdeck-plugin/src/bridge/display-tile.ts`:

- `renderStaticKey` — single line, fixed color, no flash (presets, +/-).
- `renderStaticKeyWrapped` — word-wraps up to N lines instead of shrinking font (shipping names).
- `renderStaticKeyTwoLine` — icon/big-text on top, small label below (Start Auction, Cycle
  Auction Duration).
- `renderDisplayText(Wrapped)` — flashes red then reverts to white on change; cancels any
  previous pending revert-timer keyed by action id, or rapid presses race and an old timer
  overwrites a newer value with stale text (this happened — see git history if curious).

**Hard-won lesson**: multi-line text used `<tspan>` elements inside one `<text>` block originally;
this rendered as a near-blank tile (only a tiny sliver visible) in the real Stream Deck app despite
looking correct in isolation. Switched to **separate `<text>` elements per line** — more reliably
positioned across renderers, including whatever older Qt WebEngine build Stream Deck embeds. If
text rendering ever looks broken again, suspect the same class of renderer-compatibility issue
first.

Image URLs must use `data:image/svg+xml,...` (comma, not `;base64,` unless you actually base64
it) — a bare `<svg>...</svg>` string without the data URI prefix silently does nothing.

## Why some things can't be built

- **A key can't open a Folder or switch to a page within the user's own profile.**
  `streamDeck.profiles.switchToProfile()` only works for profiles *shipped with the plugin*
  (bundled `.streamDeckProfile` files declared in the manifest) — not user-created ones, and we
  never verified we can safely hand-author that binary/JSON bundle format. **Answer for "menu on
  key press" requests**: use a native Stream Deck **Folder** (built-in feature, user creates it by
  hand, gets an automatic back button top-left and automatic pagination for free) and drop our
  Slot/Nav action instances inside it. This is why the Shipping/Article Picker pattern exists as
  loose slot+nav keys instead of a single "smart" action.
- **Display tiles can't literally reflect "the current value" AND open a folder on press** — same
  root cause. Current Price/Shipping Display press does something useful instead (reset to
  default) rather than nothing.

## Dev workflow

```
cd streamdeck-plugin
npm run build                                    # rollup, TypeScript → bin/plugin.js
npx @elgato/cli validate com.lkathke.whatnot-controller.sdPlugin
npx @elgato/cli restart com.lkathke.whatnot-controller
```

**Known gotcha — restart doesn't always actually restart.** `streamdeck restart <uuid>` sometimes
reports success without the old Node process ever exiting. If the plugin misbehaves right after a
"successful" restart, check whether the PID actually changed:

```powershell
Get-NetTCPConnection -LocalPort 9271 | Select OwningProcess   # note the PID
# ... after restart ...
Get-NetTCPConnection -LocalPort 9271 | Select OwningProcess   # same PID? restart didn't happen
```

If stale, manually kill it (`Stop-Process -Id <pid> -Force`) before restarting — otherwise the new
process's `WebSocketServer` hits `EADDRINUSE` on port 9271 (there's retry logic for this now, up
to ~6.5s of backoff in `ws-server.ts`'s `attemptBind()`, but it can still lose the race). This bug
caused a full crash-loop once (Stream Deck gave up respawning after repeated failures) — see the
next point for the actual root cause of *that*.

**Known gotcha — an uncaught error in ANY action handler used to kill the entire plugin process**,
taking every key on the deck down, not just the broken action. Root-caused to
`ensureShippingProfilesLoaded()`/`ensureListingsLoaded()` rejecting (no extension connected yet)
inside an unguarded `onWillAppear`. Fixed two ways: those two functions now never throw (they
catch, log, and return the cached/empty list), and `plugin.ts` installs global
`unhandledRejection`/`uncaughtException` handlers as a backstop. If the plugin ever seems to
vanish entirely (`Get-NetTCPConnection -LocalPort 9271` finds nothing, no node process), check
`com.lkathke.whatnot-controller.sdPlugin/logs/com.lkathke.whatnot-controller.0.log` for an
"uncaught exception" entry before assuming it's the EADDRINUSE issue above.

**Icons**: still Elgato's default placeholder PNGs (copy-pasted across every action's
`imgs/actions/<name>/` folder) — nobody's designed real icons. Cosmetic-only, not a bug.

**No automated tests.** Verification has been: `npm run build` (catches TS errors),
`npx @elgato/cli validate` (catches manifest schema errors), manual `node --check` on the
extension's `.js` files, and live testing by the user with the real Stream Deck app + a real (or
scheduled-but-not-started) Whatnot show. `getListings()`/image handling specifically has **never**
been exercised against a listing that actually has product images — treat that path as unverified.

## sdpi-components reference (Property Inspector UI)

PI HTML files use `https://sdpi-components.dev/releases/v4/sdpi-components.js` (CDN, not
vendored). Components used so far: `sdpi-item`, `sdpi-textfield`, `sdpi-select`, `sdpi-color`
(hex string). Custom plugin↔PI messaging (used for live shipping-profile dropdowns and the
shipping-order config list) goes through `SDPIComponents.streamDeckClient.send('sendToPlugin', {...})`
and `SDPIComponents.streamDeckClient.sendToPropertyInspector.subscribe(cb)` — handled plugin-side
via each action's `onSendToPlugin(ev)` override + `streamDeck.ui.sendToPropertyInspector(payload)`.

## Everything user-facing is German

Tile labels, PI field descriptions, error/status text — all German, matching the user's own
workflow language. Code comments and identifiers are English. Keep this split when adding features.
