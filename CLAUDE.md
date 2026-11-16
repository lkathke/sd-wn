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
  - `bridge.js` (`world: "MAIN"`, `document_start`) — harvests the auth headers off the Whatnot web app's own
    Apollo link chain (see the `hookApolloAuth` section below; it also still patches
    `window.fetch`, which the app no longer routes GraphQL through), and patches
    `WebSocket.prototype.send` to piggyback on the app's own Phoenix auction socket. This is how
    we read/write listings, shipping profiles, and start auctions **without our own auth** — we
    reuse whatever session the logged-in seller already has. The two Phoenix topics run over **two different
    physical connections** — `commerce:<livestreamId>` (`start_auction`,
    `pin_product`) over `/services/auction/socket`, and `auction:<livestreamId>` (`start_giveaway`,
    `select_giveaway_winner`) over `/services/live/socket` — each with its own
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

**The overlay bar gets torn out of the DOM by the page, intermittently.** Confirmed live: the
`#wn-helper-host` element was present 0.1s after load and gone 46s later, with
`document.documentElement` down to just `[HEAD, BODY]`, while `bridge.js` kept running normally in
the MAIN world. This is what makes the bar "randomly" vanish mid-show, and it reads as the whole
extension being broken when only the UI half is gone — worth ruling out first the next time
something looks dead. Likely (not proven) Whatnot's Next.js app re-rendering from the root after
one of its repeated hydration mismatches (`Minified React error #418` in the console), which sweeps
away an unexpected child of `<html>`. Moving the host to `<body>` wouldn't help — React manages
that too. `overlay.js` instead re-attaches it (`ensureHostAttached`, driven by a `MutationObserver`
on `documentElement` plus a check on every `refresh()` tick in case `documentElement` itself gets
replaced and takes the observer with it). It re-appends the **same node**: detaching doesn't
destroy the shadow root or any listener, so the bar comes back with its full current state — verified
by removing it 20 times in a row and finding the price, duration and selected listing all intact.

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

**Self-authored query documents ARE accepted** (corrected 2026-09-20 — an earlier version of this
file claimed the opposite). The old 400 Bad Request that produced that claim was never an operation
allowlist: Whatnot's endpoint expects `?operationName=<name>&ssr=0` on the POST URL, and the old
code reused whatever URL got harvested (baked in at harvest time), so the operation name in the
body never matched the one in the URL. `gql()` now builds that URL per call, and a hand-written
`query WhoAmI { me { id username } }` POSTed to `/services/graphql/` comes back 200 with the real
logged-in user. Harvesting the app's own operation text is still preferred where it's available —
it's guaranteed to match the current schema — but it is no longer the *only* path.

**The GraphQL harvest no longer works via `window.fetch`** (broke live some time before
2026-09-20). Whatnot's Apollo client is constructed with its own `fetch` implementation
(`HttpLink`'s `options.fetch`, taken from a pristine realm), so the `window.fetch` patch sees
nothing: measured live, 11 GraphQL requests in 10s and *zero* reached the patch, while
`window.fetch` was demonstrably still ours. Re-assigning `options.fetch` afterwards doesn't help
either — HttpLink reads that option into a closure when it's constructed. This is what turned the
overlay's first status dot red and, downstream, emptied the shipping-profile keys on the deck
(`getShippingProfiles()` goes through `gql()`) and silently stopped `patchListing()` from
persisting price/shipping.

What `gql()` actually needs from the app is only the **auth headers** (`authorization`,
`accept-language`, `x-client-timezone`, `X-Whatnot-USGMT`) — cookies alone are not enough, the same
request without them returns 200 with `me: null`. Those headers sit on every Apollo operation's
context, put there by a middleware link upstream of the terminating `HttpLink`, so `bridge.js` now
wraps that link's `request()` to snapshot them (`hookApolloAuth`). The client doesn't exist at
`document_start`, so an accessor is defined on `window.__APOLLO_CLIENT__` to catch the assignment,
with a bounded poll as a fallback. The `window.fetch` patch is kept as well — it costs nothing and
still covers any code path that does use the global.

**Whatnot adds required `Boolean!` feature-flag variables to its queries over time.**
`GetSellerLiveShop` gained `$includeRandomizableFields: Boolean!`, which turned every
`ensureAllListingsLoaded()` call into a hard validation error ("Variable
'$includeRandomizableFields' of required type 'Boolean!' was not provided") and left the listing
dropdown empty. Don't hardcode these: `withRequiredBooleans()` derives them from the harvested
document's own `variableDefinitions` and defaults anything missing to `false` (safe — it only omits
optional `@include` fields we never read). Variables that carry a default value in the document are
left alone. Apply it to every `client.query()` that uses a harvested document.

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

**A synthetic dropdown entry used to permanently cancel the shipping-profile load.**
`ensureProfileOption()` appends the selected listing's own profile to `profiles` when
`getShippingProfiles()` didn't return it (legacy/deleted profiles, see its comment), and
`ensureProfilesLoaded()` guarded its retry on `profiles.length > 0`. So one synthetic entry made
the guard think the real list had loaded, and the 4s retry never fired again — the bar sat on a
one-option dropdown forever. Confirmed live 2026-10-08: the select held exactly `bis 900g` (a
profile the seller no longer has) while `getShippingProfiles()` returned 11. Downstream this also
emptied the Property Inspector's dropdown and made the Stream Deck `setShippingMethod` name lookup
miss every real profile. Guard is now a separate `profilesLoaded` flag set only on a non-empty real
load; synthetic entries (`synthetic: true`) are carried over across the rebuild, since dropping the
selected listing's own `<option>` would blank the select and let `schedulePatchListing()` /
`startAuctionFromCurrentState()` wipe its shipping profile.

**`ListingImageInput` is a `@oneOf` input type — send `id` OR `key`, never both.**
`toListingInput()` sent `{ id, key }` per image, which Whatnot used to accept and now rejects with
"Exactly one key must be specified for OneOf type 'ListingImageInput'" (confirmed live 2026-10-08).
This took down every `patchListing()` caller at once — Set Start Price, Set Shipping Method and the
bar's debounced auto-save — and, less obviously, **the auction start**:
`startAuctionFromCurrentState()` calls `setShippingProfile()` before it pushes `start_auction`, so
the push never happened and the failure looked like "the auction button does nothing". The
`start_auction` path itself was fine the whole time — pushing it directly, skipping the shipping
step, started an auction normally. Both `{ id }` and `{ key }` alone are accepted (both verified
against a real listing); `id` is preferred as the stabler identifier for an existing image.

If a start ever fails again, check whether it got as far as the push at all before suspecting the
Phoenix socket: everything `startAuctionFromCurrentState()` does *before* `startAuction` is a
GraphQL write and fails the same silent way.

**`render()` used to wipe every status and error message within 1.5s.** It rebuilds the bar's
labels on each `refresh()` tick, including `$('meta')` and the start button's text, so all 25-odd
transient messages (every Stream Deck command's "✓"/"Fehler: …" feedback, the start button's own
`startet …`/`läuft ✓`/`Fehler: …`, and its two-step `Bestätigen: …` label) were overwritten almost
immediately. Measured live: a successful start flickered `startet …` → `Auktion starten` →
`läuft ✓` → `Auktion starten`, and the GraphQL error above could only be read by freezing it in a
screenshot. The armed label vanishing was the worst of it — the button still *was* armed, so the
next click fired the auction instead of arming it. Fixed with two overrides `render()` respects:
`setMetaMessage(text, ttl)` / `renderMeta(fallback)` for the meta line (8s default, 4s for the
giveaway entry counter so a stale count doesn't linger) and `goOverride` / `setGoText()` /
`clearGoText()` for the button. Start errors are mirrored into the meta line as well, since the
button is far too narrow for a GraphQL validation message.

**Whatnot soft-deletes shipping profiles**, it doesn't remove them: a deleted profile keeps
existing with `isActive: false` and stays assigned to whatever live listings already pointed at it.
`customShippingProfiles`/`suggestedShippingProfiles` return only active ones and take no argument
to ask for the rest (`isActive` is rejected as an unknown argument), and the app's own
`GetSellerLiveListing` doesn't select `isActive` either. `bridge.js`'s
`getAssignedShippingProfile()` therefore asks per listing with a self-authored
`GetListingShippingProfileState` document. That lookup is required, not cosmetic: "missing from
the loaded list" alone does **not** mean deleted — a listing from another category legitimately
carries an active profile that this category's suggestions don't include, and only `isActive`
separates the two. `overlay.js` hides soft-deleted profiles from the dropdown entirely and preselects the seller's
first own profile in their place, writing nothing — it reaches the server on the next ordinary save,
the same as a pick made by hand. The preselect is gated on a *confirmed* `isActive: false`, not on
mere absence from the list, so the window before that lookup resolves can't overwrite a profile that
turns out to be valid. The bar shows no notice about the stale assignment (asked for explicitly):
between the preselect and that first save, what it displays is not yet what the listing holds.

Hiding it makes the `<select>` blank, which every **write** path has to special-case —
`assignedProfileHidden()` in `overlay.js`. `schedulePatchListing()` omits `shippingProfileId` from
the patch entirely in that case (`toListingInput()` then defaults it to the listing's own current
value, i.e. leaves it alone) and `startAuctionFromCurrentState()` skips its `setShippingProfile`
call. Sending `null` instead would **delete** the profile, since `UpdateListing` replaces the
listing rather than merging. Verified end-to-end: a real price patch on a listing carrying an
inactive profile round-tripped with the profile intact.

**The bar deliberately shows only the seller's own shipping profiles** (`onlyOwnProfiles()` in
`overlay.js`, filtering on the `source: 'custom' | 'suggested'` tag `getShippingProfiles()` puts on
each entry). Whatnot's category suggestions ("Onesie/Bodysuit", "Babysocken/-mütze", …) are noise
for this workflow, where everything ships by weight. A suggested profile that's actually *assigned*
to a listing still stays selectable, because `ensureProfileOption()` injects it on demand.

A consequence worth knowing if suggestions are ever shown again: **`suggestedShippingProfiles` is
category-scoped and the category is often not known yet** when `ensureProfilesLoaded()` first
succeeds (the listing dropdown hasn't populated). Measured live on this seller: 11 profiles with a
`categoryId`, only their 4 custom ones without — and since the load latches on first success,
whichever state existed at that moment would be frozen in for the whole session. `customShipping
Profiles` takes no `categoryId`, so with the custom-only filter there is nothing to reload and no
category tracking in the code.

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
