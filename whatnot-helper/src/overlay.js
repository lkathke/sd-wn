const call = (() => {
  let n = 0;
  const waiting = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__wn !== 'res') return;
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    e.data.ok ? w.res(e.data.result) : w.rej(new Error(e.data.error));
  });
  return (method, ...args) => new Promise((res, rej) => {
    const id = ++n;
    waiting.set(id, { res, rej });
    window.postMessage({ __wn: 'req', id, method, args }, location.origin);
    setTimeout(() => waiting.delete(id) && rej(new Error('RPC-Timeout')), 15000);
  });
})();

const host = document.createElement('div');
host.id = 'wn-helper-host';
document.documentElement.appendChild(host);
const root = host.attachShadow({ mode: 'open' });
root.innerHTML = `
  <style>
    :host { all: initial; }
    .bar { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
           z-index: 2147483647; display: flex; gap: 12px; align-items: center;
           background: #14161a; color: #fff; border: 1px solid #2b2f36;
           border-radius: 12px; padding: 10px 14px;
           font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.45);
           transition: box-shadow .15s ease; }
    .bar.pulse { box-shadow: 0 0 0 3px #ff5a1f, 0 8px 24px rgba(0,0,0,.45); }
    select, input { background:#1e2228; color:#fff; border:1px solid #333a44;
                    border-radius:8px; padding:6px 8px; font:inherit; }
    input[type=number] { width: 84px; }
    button { background:#ff5a1f; color:#fff; border:0; border-radius:8px;
             padding:8px 14px; font:600 13px system-ui; cursor:pointer; }
    button[disabled] { opacity:.45; cursor:not-allowed; }
    .meta { opacity:.7; font-size:12px; }
    .dots { display:flex; gap:4px; }
    .dot { width:8px; height:8px; border-radius:50%; background:#e5484d; }
    .dot.ok { background:#30a46c; }
    .field { display:flex; flex-direction:column; gap:2px; }
    .field span { font-size:9px; text-transform:uppercase; letter-spacing:.04em; opacity:.5; }
  </style>
  <div class="bar" id="bar">
    <span class="dots">
      <span class="dot" id="dot" title="Verbindung zur Whatnot-App (GraphQL/Socket)"></span>
      <span class="dot" id="dotSd" title="Verbindung zum Stream Deck"></span>
    </span>
    <label class="field"><span>Artikel</span>
      <select id="listing" title="Welches Listing gesteuert wird"></select>
    </label>
    <label class="field"><span>Versand</span>
      <select id="profile" title="Versandprofil für dieses Listing"></select>
    </label>
    <label class="field"><span>Preis</span>
      <input id="price" type="number" min="1" step="0.5" title="Startpreis in Euro" />
    </label>
    <label class="field"><span>Dauer</span>
      <select id="duration" title="Auktionsdauer">
        <option value="2">2 s</option><option value="3">3 s</option><option value="5">5 s</option>
        <option value="7">7 s</option><option value="10">10 s</option><option value="15">15 s</option>
        <option value="20">20 s</option><option value="30" selected>30 s</option><option value="45">45 s</option>
        <option value="60">1 min</option><option value="90">1 min 30 s</option><option value="120">2 min</option>
        <option value="150">2 min 30 s</option><option value="180">3 min</option><option value="210">3 min 30 s</option>
        <option value="240">4 min</option><option value="270">4 min 30 s</option><option value="300">5 min</option>
      </select>
    </label>
    <label class="field"><span>Bump</span>
      <select id="bump" title="Zeit für Gegengebote: verlängert die Auktion bei einem Gebot kurz vor Ablauf um diese Sekundenzahl">
        <option value="2">2 s</option><option value="3">3 s</option><option value="5">5 s</option>
        <option value="7">7 s</option><option value="10" selected>10 s</option>
      </select>
    </label>
    <label class="field"><span>Modus</span>
      <select id="mode" title="Standard verlängert bei Gegengeboten, Sudden Death nicht — wer bei 0 vorn liegt, gewinnt">
        <option value="standard" selected>Standard</option>
        <option value="suddenDeath">Sudden Death</option>
      </select>
    </label>
    <button id="go" title="Startet Auktion/Giveaway mit den oben eingestellten Werten (zweistufig: erst bestätigen, dann startet's)"></button>
    <button id="win" disabled title="Zieht einen Gewinner für das laufende Giveaway (oder beendet es ohne Gewinner)">Gewinner ziehen</button>
    <span class="meta" id="meta"></span>
  </div>`;

const $ = (id) => root.getElementById(id);
let listings = [], profiles = [], armed = false;
let activeGiveawayProductUuid = null; // set by giveaway_started, cleared on won/ended-without-winner
// Which listing.id activeGiveawayProductUuid belongs to. Needed because activeGiveawayProductUuid
// is a per-run instance id in a completely different id namespace than any listing/salesChannels
// id (confirmed live) — it can never be compared against a listing directly, only recorded
// alongside "which listing was selected when this run started" for the win-button guard in
// render() below.
let activeGiveawayListingId = null;

// getListings() only reflects whatever the dashboard's own listing-list query already put in the
// Apollo cache, which doesn't always include shippingProfile (confirmed: a real listing had
// `price` but no `shippingProfile` key at all). Lazily fetch it per selected listing via
// bridge.js's getListingShippingProfile() instead of trusting the list cache for that field.
//
// That call is self-sufficient — it only needs *some* GraphQL request to have been harvested (any
// one, not specifically this query; see bridge.js's Q_LISTING_SHIPPING comment) — but that harvest
// can still lose the race against our very first attempt right after page load. Retry on a
// cooldown instead of giving up permanently, so it self-heals within a few seconds.
let listingDetails = null, listingDetailsId = null, listingDetailsFetchingId = null;
let listingDetailsFailedId = null, listingDetailsFailedAt = 0;
const LISTING_DETAILS_RETRY_MS = 4000;

function ensureListingDetails(l) {
  if (!l || l.id === listingDetailsId || l.id === listingDetailsFetchingId) return;
  if (l.id === listingDetailsFailedId && Date.now() - listingDetailsFailedAt < LISTING_DETAILS_RETRY_MS) return;

  listingDetailsFetchingId = l.id;
  call('getListingDetails', l.id, LIVESTREAM_ID)
    .then((d) => { listingDetails = d; listingDetailsId = l.id; listingDetailsFailedId = null; })
    .catch(() => { listingDetailsFailedId = l.id; listingDetailsFailedAt = Date.now(); })
    .finally(() => { listingDetailsFetchingId = null; render(); });
}

async function refresh() {
  const st = await call('status');
  $('dot').className = 'dot' + (st.gqlReady && st.socketReady ? ' ok' : '');
  void ensureAllListingsLoaded();
  const fresh = await call('getListings');
  const sel = $('listing');
  const keep = sel.value;
  // getListings() reads a live snapshot of whatever's currently in the Apollo cache — confirmed
  // live that a listing can transiently vanish from it for one tick while an in-flight
  // network-only refetch is repopulating the cache (patchListing()'s refetchQueries(['GetSeller
  // LiveListing']) triggers exactly that, so this hit reliably during rapid Stream Deck price
  // presses, each firing its own patch+refetch). Rebuilding the <select> from an incomplete
  // snapshot would silently drop `keep` and fall back to the browser's default (whichever option
  // ends up first — observed live: it landed on a GIVEAWAY listing while editing an auction's
  // price), which then only "self-corrected" whenever some other command happened to force-reselect
  // the right listing. Skip the rebuild entirely on a tick where the previously-selected listing
  // would disappear — better a stale-but-correct dropdown for 1.5s than a wrong selection.
  if (keep && !fresh.some(l => l.id === keep)) {
    // Deliberately NOT updating the `listings` array here either — current() looks the selected
    // id up in it, and swapping to the incomplete `fresh` array would make current() return
    // undefined this tick (selected id genuinely missing from it) even though the <select>'s own
    // option is still sitting there showing the old, correct listing.
    void ensureProfilesLoaded();
    render();
    return;
  }
  listings = fresh;
  sel.innerHTML = listings.map(l =>
    `<option value="${l.id}">${l.title} · ${l.quantity}×</option>`).join('');
  if (keep) sel.value = keep;
  void ensureProfilesLoaded();
  render();
}

// getListings() only reflects whatever the seller has actually clicked a tab for at least once —
// confirmed live: a GIVEAWAY listing was completely invisible to the overlay (and thus unselectable
// from the Stream Deck) until the "Giveaways" tab was clicked in the browser once. Proactively fire
// the same query bridge.js's ensureAllListingsLoaded() uses for every transaction type exactly
// once, on the same startup-race/retry pattern as ensureProfilesLoaded/ensureListingDetails above.
let allListingsLoaded = false, allListingsLoadFailedAt = 0;
const ALL_LISTINGS_RETRY_MS = 4000;

async function ensureAllListingsLoaded() {
  if (allListingsLoaded) return;
  if (Date.now() - allListingsLoadFailedAt < ALL_LISTINGS_RETRY_MS) return;
  try {
    await call('ensureAllListingsLoaded', LIVESTREAM_ID);
    allListingsLoaded = true;
  } catch {
    allListingsLoadFailedAt = Date.now();
  }
}

// Same startup race as ensureListingDetails: the very first call can fire before the app has made
// any GraphQL request of its own yet. Retry on a cooldown via refresh()'s 1.5s poll instead of
// only trying once — an uncaught rejection here used to abort the whole init IIFE below it,
// including the setInterval(refresh, ...) call, silently freezing the entire bar until reload.
let profilesLoadFailedAt = 0;
const PROFILES_LOAD_RETRY_MS = 4000;

async function ensureProfilesLoaded() {
  if (profiles.length > 0) return;
  if (Date.now() - profilesLoadFailedAt < PROFILES_LOAD_RETRY_MS) return;
  try {
    const cat = current()?.category?.id ?? current()?.categoryId;
    profiles = await call('getShippingProfiles', cat);
    if (profiles.length > 0) {
      $('profile').innerHTML = profiles.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      render();
    } else {
      profilesLoadFailedAt = Date.now();
    }
  } catch {
    profilesLoadFailedAt = Date.now();
  }
}

// A listing's actually-assigned shipping profile isn't always among the seller's "suggested" +
// "custom" profiles that populate the dropdown (confirmed live: a listing had a profile assigned
// that getShippingProfiles() never returned — likely no longer suggested for its category, or a
// legacy profile). Without this, `$('profile').value = <that id>` silently fails (no matching
// <option>, select shows blank) and worse, startAuctionFromCurrentState() then sees the blank as
// a "change" and calls setShippingProfile with an empty value, wiping the listing's profile.
function ensureProfileOption(id, name) {
  if (!id || !name || profiles.some(p => p.id === id)) return;
  profiles = [...profiles, { id, name }];
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = name;
  $('profile').appendChild(opt);
}

function current() { return listings.find(l => l.id === $('listing').value); }
function isGiveaway(l) { return l?.transactionType === 'GIVEAWAY'; }
// Only used by the parked native-panel-highlight experiment below (see applyNativeSync) to match
// against the native product list's thumbnail <img alt>, which turned out to just be an internal
// image-asset id — NOT the real commerce product id. See salesChannelProductId() further down for
// that; the two are different UUID namespaces, confirmed live (a real listing's l.product.uuid is
// always undefined, and pin_product with the image-asset id 404s with PRODUCT_NOT_FOUND).
function nativeUuid(l) { return l?.product?.uuid ?? l?.productUuid; }

// Best-effort sync into Whatnot's own product panel on the left, so the seller can see (and click)
// which listing the overlay currently has selected without cross-referencing two lists by eye.
// Everything here is scraping the live app's own DOM — there's no API for "which row is this" —
// so it's wrapped defensively and fails silently if Whatnot's markup changes under us; it must
// never be able to break the overlay itself.
//
// The product list ("Angebote"/"Auktion"/"Giveaways"/"Sofortkauf"/…) is rendered via
// react-virtuoso (confirmed live via its data-testid="virtuoso-item-list" wrapper) — only rows
// currently scrolled into view actually exist in the DOM. That's why the highlight is re-applied
// on every render() (piggybacking on the existing 1.5s refresh() poll) rather than once: a row
// that isn't mounted yet when the listing is first selected will pick up the highlight as soon as
// it scrolls into view and the next render() runs.
function nativePanelRoot() {
  const search = document.querySelector('input[placeholder="Produkte suchen..."]');
  let node = search;
  for (let i = 0; i < 10 && node; i++) {
    if (node.querySelector('[data-testid="virtuoso-item-list"]')) return node;
    node = node.parentElement;
  }
  return null;
}

// Guessed from the German tab label ("Sofortkauf" = "Buy now") — unverified against a real
// BUY_NOW/FIXED_PRICE listing, we've only ever seen AUCTION and GIVEAWAY live. Worst case this
// mismatches and switchNativeTab() below just no-ops (tab text not found), it doesn't break
// anything — see the try/catch wrapper in applyNativeSync.
function desiredTabLabel(l) {
  if (isGiveaway(l)) return 'Giveaways';
  if (l.transactionType === 'BUY_NOW' || l.transactionType === 'FIXED_PRICE') return 'Sofortkauf';
  return 'Auktion';
}

// DISABLED — synthetically clicking Whatnot's own React-managed tab button crashed the live
// dashboard page outright (uncaught "Minified React error #418", a hydration mismatch that tears
// down the whole React tree) the first time this ran live. Left in place as a no-op rather than
// removed so the intent stays documented, but do not re-enable the tab.click() below without a
// safer trigger mechanism (e.g. dispatching real PointerEvents instead of .click(), and/or only
// ever doing this well after the page is confirmed idle) verified live first.
function switchNativeTab(_label) {
  // no-op — see comment above
}

let highlightedRow = null;

function highlightNativeListing(uuid) {
  if (highlightedRow) { highlightedRow.style.outline = ''; highlightedRow.style.outlineOffset = ''; highlightedRow = null; }
  const root = nativePanelRoot();
  if (!root || !uuid) return;
  const img = root.querySelector(`img[alt="${CSS.escape(uuid)}"]`);
  if (!img) return; // row not mounted right now (virtualized, scrolled out) — picks up on next render()
  // img -> thumbnail button -> rounded/overflow-hidden frame -> the actual row. Highlighting the
  // frame itself would get clipped by its own overflow-hidden, so walk one more level up.
  const row = img.parentElement?.parentElement?.parentElement ?? img.parentElement;
  row.style.outline = '3px solid #ef4444';
  row.style.outlineOffset = '-3px';
  highlightedRow = row;
}

function applyNativeSync(switchTab) {
  try {
    const l = current();
    if (!l) { highlightNativeListing(null); return; }
    if (switchTab) switchNativeTab(desiredTabLabel(l));
    highlightNativeListing(nativeUuid(l));
  } catch {
    // Scraping Whatnot's own DOM — never let a markup change here take the overlay down with it.
  }
}

// Shared by the listing <select>'s own change handler, the Stream Deck "selectListing" command,
// and clicks on a listing row in Whatnot's native panel (see the delegated click listener below) —
// one place that both updates the overlay and (re)syncs the native panel highlight/tab.
function selectListingById(id, { switchTab = true } = {}) {
  $('listing').value = id;
  delete $('price').dataset.touched;
  delete $('profile').dataset.touched;
  applyListingPrefs(id);
  render();
  applyNativeSync(switchTab);
}

// The real product UUID Whatnot's Phoenix commerce socket expects for pin_product/unpin_product/
// start_auction's productId/start_giveaway/select_giveaway_winner — confirmed live via a manual
// pin_product push (status: "ok", server echoed this same id back under response.product.id).
// l.product?.uuid and l.productUuid (used throughout this file previously) never actually exist in
// any query response we've captured; this SalesChannelMeta entry is the correct source instead.
function salesChannelProductId(l) {
  return l?.salesChannels?.find(c => c.meta?.type === 'LIVESTREAM_PRODUCT_ID')?.meta?.id;
}

// Stream Deck presses don't carry "which listing" the way the overlay's own dropdown does — a
// physical key just means "the auction" or "the giveaway" in general. Resolves to the currently
// selected listing if it already matches the wanted type, otherwise falls back to the first
// listing of that type in the list (stable order from getListings(), so "first" is consistent
// press to press). Switches the overlay's own selection to match via selectListingById() so the
// bar visually reflects whatever the key just acted on, same as pressing the dropdown by hand.
function resolveListingForType(wantGiveaway) {
  const l = current();
  if (l && isGiveaway(l) === wantGiveaway) return l;
  return listings.find((x) => isGiveaway(x) === wantGiveaway) ?? null;
}

function selectListingForType(wantGiveaway) {
  const target = resolveListingForType(wantGiveaway);
  if (!target) return null;
  if (target.id !== $('listing').value) selectListingById(target.id);
  return target;
}

function eligibilityLabel(l) {
  const g = l?.transactionProps?.giveaway;
  if (!g) return '';
  if (g.buyerAppreciation) return 'Buyer Appreciation';
  if (g.onlyFollowers) return 'Nur Follower';
  return 'Jeder';
}

function render() {
  sendArticleState();
  const l = current();
  if (!l) return;
  const giveaway = isGiveaway(l);
  ensureListingDetails(l);
  highlightNativeListing(nativeUuid(l)); // tab switching only happens on an actual selection change

  // Preis/Versand/Dauer/Modus sind Auktions-only — bei einem Giveaway-Listing überträgt der Start
  // nur die Produkt-UUID, keine dieser Felder (siehe Doku Teil A.1).
  for (const id of ['price', 'duration', 'bump', 'mode']) $(id).closest('.field').style.display = giveaway ? 'none' : '';
  $('go').textContent = giveaway ? 'Giveaway starten' : 'Auktion starten';
  $('win').disabled = !(giveaway && activeGiveawayProductUuid && l.id === activeGiveawayListingId);

  // Shipping profile sync applies to BOTH auction and giveaway listings — a giveaway listing
  // carries a real shippingProfile too (confirmed live, e.g. a "Bis 50g" profile on one), it's
  // just not part of the start_giveaway push itself the way it's part of start_auction's payload.
  // shippingProfile sits under `product` in GetSellerLiveListing's response shape, not at the
  // top level — confirmed live via readListing()'s diagnostic log.
  const detailedProfile = listingDetailsId === l.id ? listingDetails?.product?.shippingProfile : undefined;
  ensureProfileOption(detailedProfile?.id, detailedProfile?.name);
  // Deliberately NOT falling back to l.shippingProfile (the list-cache's own copy of this field)
  // while detailedProfile hasn't loaded yet — confirmed live that fallback briefly showed a wrong
  // profile (e.g. during rapid Adjust Start Price presses, before ensureListingDetails' fetch for
  // this listing had resolved) that then "corrected itself" a moment later. Leaving the field blank
  // during that window is confusing for a frame but never wrong, unlike a stale/incorrect guess.
  if (!$('profile').dataset.touched) $('profile').value = detailedProfile?.id ?? '';
  const p = profiles.find(x => x.id === $('profile').value);
  const shippingLabel = p
    // Synthetic fallback entries (see ensureProfileOption) only carry id+name, not the full
    // ShippingProfile fragment — weightAmount is undefined for those, so skip the dimensions bit.
    ? `${p.name}` + (p.weightAmount != null ? ` · ${p.weightAmount} ${p.weightScale} · ${p.length}×${p.width}×${p.height}` : '')
    : (listingDetailsFailedId === l.id
        ? 'Versandprofil wird geladen …' // retries automatically, see ensureListingDetails
        : 'kein Versandprofil');

  if (giveaway) {
    const g = l.transactionProps?.giveaway;
    const intl = g && !g.onlyDomestic;
    $('meta').textContent = `🎁 ${eligibilityLabel(l)} · ${intl ? 'international' : 'nur national'}`
      + (activeGiveawayProductUuid ? ' · läuft' : '') + ` · ${shippingLabel}`;
    sendOverlayState();
    return;
  }

  if (!$('price').dataset.touched) $('price').value = (l.price.amount / 100).toFixed(2);
  $('meta').textContent = shippingLabel;

  sendOverlayState();
}

function pulseBar() {
  $('bar').classList.add('pulse');
  setTimeout(() => $('bar').classList.remove('pulse'), 400);
}

// Shared by the browser "Auktion starten" button and the Stream Deck "startAuction" command —
// both act on whatever the overlay currently shows (selected listing, price, shipping, duration,
// bump). The Stream Deck button intentionally skips the browser button's two-step confirm: it's a
// dedicated physical key, not a hover-prone web button, so a single press is the expected UX.
async function startAuctionFromCurrentState() {
  const l = current();
  if (!l) throw new Error('Kein Listing ausgewählt');

  const cents = Math.round(parseFloat($('price').value) * 100);

  // shippingProfile sits under `product` in GetSellerLiveListing's response shape, not at the
  // top level — confirmed live via readListing()'s diagnostic log. Not falling back to
  // l.shippingProfile here either (see render()'s comment on the same fallback) — if we don't
  // actually know the server's current value yet, treat it as unknown (never equal to whatever's
  // in the field) so this errs toward sending a redundant setShippingProfile rather than skipping
  // a needed one.
  const detailedShippingId = listingDetailsId === l.id ? listingDetails?.product?.shippingProfile?.id : undefined;
  const knownShippingId = detailedShippingId ?? '';
  // render() already injected a synthetic <option> for this id if it wasn't among the
  // suggested/custom profiles — see ensureProfileOption — so $('profile').value reliably matches
  // knownShippingId here instead of falling back to '' and wiping the profile below.
  if ($('profile').value !== knownShippingId) {
    await call('setShippingProfile', l.id, LIVESTREAM_ID, $('profile').value);
  }
  await call('startAuction', {
    productUuid: salesChannelProductId(l),
    cents,
    durationSeconds: +$('duration').value,
    bumpThresholdSeconds: +$('bump').value,
    mode: $('mode').value,
  });
}

async function startGiveawayFromCurrentState() {
  const l = current();
  if (!l) throw new Error('Kein Listing ausgewählt');
  // Don't set activeGiveawayProductUuid here — the id the server actually wants for
  // select_giveaway_winner is a per-run instance id that only becomes known via the
  // "giveaway_started" broadcast (see that handler below), not the static salesChannels id used to
  // start it. Setting it here used to stick a wrong value that drawGiveawayWinnerFromCurrentState
  // never even read anyway (see below) — the "läuft ✓" / "Gewinner ziehen" button just wait the
  // ~instant it takes for that broadcast to arrive, same as giveaway_entry_count_updated etc.
  await call('startGiveaway', salesChannelProductId(l));
  render();
}

async function drawGiveawayWinnerFromCurrentState() {
  const l = current();
  if (!l) throw new Error('Kein Listing ausgewählt');
  if (!activeGiveawayProductUuid) throw new Error('Kein laufendes Giveaway erkannt');
  // Confirmed live: select_giveaway_winner needs the giveaway RUN's id (learned from the
  // "giveaway_started" broadcast into activeGiveawayProductUuid below), not salesChannelProductId —
  // the static per-listing id used to *start* the giveaway 400s here with GIVEAWAY_ALREADY_ENDED
  // even while a giveaway is actively running, since the server treats it as referring to a
  // different, already-concluded run.
  await call('drawGiveawayWinner', activeGiveawayProductUuid);
}

// Two explicit buttons rather than one toggle: Whatnot doesn't broadcast a pin/unpin status event
// (unlike giveaways, see FORWARDED_EVENTS in bridge.js), so the overlay has no reliable way to know
// whether the currently selected listing is actually pinned right now — a toggle could easily get
// out of sync with reality (e.g. someone unpins from the native UI directly). Two idempotent
// actions avoid needing to track that state at all.
async function pinListingFromCurrentState() {
  const l = current();
  if (!l) throw new Error('Kein Listing ausgewählt');
  await call('pinProduct', salesChannelProductId(l));
}

async function unpinListingFromCurrentState() {
  const l = current();
  if (!l) throw new Error('Kein Listing ausgewählt');
  await call('unpinProduct', salesChannelProductId(l));
}

$('go').addEventListener('click', async () => {
  const l = current();
  const giveaway = isGiveaway(l);
  const label = giveaway
    ? `Bestätigen: 🎁 „${l.title}" · ${eligibilityLabel(l)}`
    : (() => {
        const cents = Math.round(parseFloat($('price').value) * 100);
        const p = profiles.find(x => x.id === $('profile').value);
        return `Bestätigen: 🔨 „${l.title}" · ${(cents / 100).toFixed(2)} € · ${p?.name} · `
          + `${$('mode').selectedOptions[0].text} · ${$('duration').value}s`;
      })();
  const idleLabel = giveaway ? 'Giveaway starten' : 'Auktion starten';

  if (!armed) {
    armed = true;
    $('go').textContent = label;
    setTimeout(() => { armed = false; $('go').textContent = idleLabel; }, 6000);
    return;
  }

  armed = false;
  $('go').disabled = true;
  $('go').textContent = 'startet …';
  try {
    await (giveaway ? startGiveawayFromCurrentState() : startAuctionFromCurrentState());
    $('go').textContent = 'läuft ✓';
  } catch (e) {
    $('go').textContent = 'Fehler: ' + e.message;
  } finally {
    setTimeout(() => { $('go').disabled = false; $('go').textContent = idleLabel; }, 3000);
  }
});

$('win').addEventListener('click', async () => {
  $('win').disabled = true;
  $('meta').textContent = 'zieht Gewinner …';
  try {
    await drawGiveawayWinnerFromCurrentState();
  } catch (e) {
    $('meta').textContent = 'Fehler: ' + e.message;
    $('win').disabled = false;
  }
});

// Live-Events vom Auktions-Socket, von bridge.js weitergeleitet (siehe FORWARDED_EVENTS dort) —
// so braucht es kein Polling für Teilnehmerzahl/Ende des Giveaways.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.__wn !== 'event') return;
  const { event, payload } = e.data;
  switch (event) {
    case 'giveaway_started':
      // Confirmed live: this broadcast's payload has no "productId"/"product_id" field at all
      // (its keys are id/product/giveaway/sloStories) — the old code above always fell through to
      // null here, permanently, since day one. The real per-run instance id select_giveaway_winner
      // needs is the top-level "id" (verified live: it matched exactly what the native "Giveaway
      // beenden" button itself sent as its own select_giveaway_winner productId).
      activeGiveawayProductUuid = payload?.id ?? payload?.product?.id ?? null;
      activeGiveawayListingId = current()?.id ?? null;
      render();
      break;
    case 'giveaway_entry_count_updated': {
      const count = payload?.entryCount ?? payload?.entry_count;
      if (count != null) $('meta').textContent = `🎁 läuft · ${count} Teilnehmer`;
      break;
    }
    case 'giveaway_won':
    case 'giveaway_ended_without_winner':
      activeGiveawayProductUuid = null;
      activeGiveawayListingId = null;
      render();
      break;
  }
});

const LIVESTREAM_ID = location.pathname.split('/').pop();

// Persists price/shipping to the actual listing record (not just what the overlay locally shows),
// debounced. This matters once a listing is pinned: the pinned preview buyers see is the *listing's
// persisted* price/shippingProfile, not anything staged only in this bar — without this, adjusting
// price after pinning silently doesn't reach the audience until the auction actually starts (which
// does its own one-off shipping patch, see startAuctionFromCurrentState). Debounced rather than
// firing per edit so e.g. holding "+1" (Adjust Start Price's repeat-while-held) or clicking through
// shipping profiles with "◀/▶" doesn't fire an UpdateListing mutation per intermediate step — only
// once things settle.
const PATCH_DEBOUNCE_MS = 800;
let patchDebounceTimer = null;

function schedulePatchListing() {
  const l = current();
  if (!l) return;
  clearTimeout(patchDebounceTimer);
  patchDebounceTimer = setTimeout(() => {
    const patch = { shippingProfileId: $('profile').value || null };
    // Giveaways have a real shippingProfile (see render()'s comment) but no editable price in
    // this bar (the field's hidden and its value is stale/irrelevant for a giveaway selection) —
    // omitting price from the patch leaves toListingInput() default to the listing's own current
    // price instead of overwriting it with garbage from a hidden input.
    if (!isGiveaway(l)) {
      const cents = Math.round(parseFloat($('price').value) * 100);
      if (!Number.isFinite(cents)) return;
      patch.price = { amount: cents, currency: 'EUR' };
    }
    call('patchListing', l.id, LIVESTREAM_ID, patch)
      .catch((e) => { $('meta').textContent = 'Fehler beim Speichern: ' + e.message; });
  }, PATCH_DEBOUNCE_MS);
}

// Dauer/Bump/Modus sind bei Whatnot keine Eigenschaften des Listings (nur Preis und Versand sind
// das, siehe ensureListingDetails oben) — sie werden erst beim Auktionsstart mitgeschickt, es gibt
// serverseitig nichts, das man pro Artikel "laden" könnte. Wir merken sie uns stattdessen selbst,
// pro Listing-ID, in localStorage (geteilt mit whatnot.com, aber unter eigenem Namespace).
const LISTING_PREFS_KEY = 'wn-helper:listingPrefs';

function loadListingPrefs() {
  try { return JSON.parse(localStorage.getItem(LISTING_PREFS_KEY)) || {}; } catch { return {}; }
}

function saveListingPref(listingId, patch) {
  if (!listingId) return;
  const all = loadListingPrefs();
  all[listingId] = { ...all[listingId], ...patch };
  try { localStorage.setItem(LISTING_PREFS_KEY, JSON.stringify(all)); } catch {}
}

function applyListingPrefs(listingId) {
  const prefs = loadListingPrefs()[listingId];
  if (!prefs) return;
  if (prefs.durationSeconds != null) {
    const opt = Array.from($('duration').options).find(o => o.value === String(prefs.durationSeconds));
    if (opt) $('duration').value = opt.value;
  }
  if (prefs.bumpSeconds != null) {
    const opt = Array.from($('bump').options).find(o => o.value === String(prefs.bumpSeconds));
    if (opt) $('bump').value = opt.value;
  }
  if (prefs.mode) $('mode').value = prefs.mode;
}

// Reverse direction of the Stream Deck bridge: reports the bar's current price/shipping/mode to
// the plugin whenever they change here in the browser, so Current Price/Shipping Display and the
// Sudden Death toggle key stay correct even when the *browser* bar was edited, not a deck key.
// `sdSocket` is set by the "Stream Deck Bridge" IIFE below once connected.
let sdSocket = null;
let lastSentOverlayState = null;
let lastSentArticleState = null;

// Same heuristic as the plugin's own (unverified) extractImageUrl in article-picker.ts — kept in
// sync manually rather than shared, since one lives in the browser extension and the other in the
// Node plugin process with no shared module system between them.
function extractImageUrl(l) {
  const first = Array.isArray(l?.images) ? l.images[0] : (l?.image ?? l?.thumbnail);
  if (!first) return undefined;
  if (typeof first === 'string') return first;
  if (typeof first === 'object') return first.url ?? first.imageUrl ?? first.src ?? first.href;
  return undefined;
}

// Reports which listing each Current Article Display tile (auction/giveaway) should currently
// show — independent of the overlay's own dropdown selection, since a Stream Deck key press for
// "the auction article" always means resolveListingForType(false)'s result, not necessarily
// whatever the bar happens to have selected right now (see selectListingForType/resolveListingForType).
function sendArticleState() {
  if (!sdSocket || sdSocket.readyState !== WebSocket.OPEN) return;
  const toArticle = (l) => l ? { id: l.id, title: l.title, imageUrl: extractImageUrl(l) } : null;
  const state = {
    auction: toArticle(resolveListingForType(false)),
    giveaway: toArticle(resolveListingForType(true)),
  };
  const key = JSON.stringify(state);
  if (key === lastSentArticleState) return;
  lastSentArticleState = key;
  sdSocket.send(JSON.stringify({ type: 'articleState', ...state }));
}

function sendOverlayState() {
  const l = current();
  if (!l || !sdSocket || sdSocket.readyState !== WebSocket.OPEN) return;

  const giveaway = isGiveaway(l);
  const p = profiles.find(x => x.id === $('profile').value);
  // priceCents/mode are meaningless for a giveaway selection (no price field shown, no auction
  // mode) — only shippingLabel applies to both, tagged with which tracker it belongs to (see
  // state/current-shipping.ts) since the plugin can't otherwise tell which target this snapshot is
  // for.
  const cents = giveaway ? NaN : Math.round(parseFloat($('price').value) * 100);
  const state = {
    priceCents: Number.isFinite(cents) ? cents : undefined,
    shippingLabel: p?.name,
    mode: giveaway ? undefined : $('mode').value,
    target: giveaway ? 'giveaway' : 'auction',
  };
  const key = JSON.stringify(state);
  if (key === lastSentOverlayState) return;
  lastSentOverlayState = key;
  sdSocket.send(JSON.stringify({ type: 'overlayState', ...state }));
}

$('price').addEventListener('input', () => { $('price').dataset.touched = '1'; sendOverlayState(); schedulePatchListing(); });
$('profile').addEventListener('change', () => { $('profile').dataset.touched = '1'; render(); schedulePatchListing(); });
$('duration').addEventListener('change', () => {
  saveListingPref(current()?.id, { durationSeconds: +$('duration').value });
});
$('bump').addEventListener('change', () => {
  saveListingPref(current()?.id, { bumpSeconds: +$('bump').value });
});
$('mode').addEventListener('change', () => {
  saveListingPref(current()?.id, { mode: $('mode').value });
  sendOverlayState();
});
$('listing').addEventListener('change', () => selectListingById($('listing').value));

// Delegated (capture, non-blocking) click listener on the native Whatnot product panel: syncs the
// overlay's selection whenever the seller clicks a listing row directly on the left, instead of
// only via the overlay's own dropdown. Never calls preventDefault/stopPropagation — Whatnot's own
// click handling for that row (opening "Produktaktionen" etc.) must keep working untouched, this
// only piggybacks on the same click as a signal.
document.addEventListener('click', (e) => {
  try {
    const root = nativePanelRoot();
    if (!root || !root.contains(e.target)) return;
    let node = e.target;
    for (let i = 0; i < 6 && node; i++) {
      const img = node.querySelector?.('img[alt]');
      if (img) {
        const match = listings.find(l => nativeUuid(l) === img.alt);
        if (match && match.id !== $('listing').value) selectListingById(match.id);
        return;
      }
      node = node.parentElement;
    }
  } catch {
    // See applyNativeSync's comment — scraping Whatnot's DOM must never break the overlay.
  }
}, true);

(async () => {
  // refresh() itself calls ensureProfilesLoaded() and render() — no separate handling needed here,
  // and setInterval always runs regardless of whether that first attempt succeeds (see
  // ensureProfilesLoaded's comment for why that used to not be true).
  await refresh();
  applyListingPrefs(current()?.id);
  render();
  applyNativeSync(true);
  setInterval(refresh, 1500);
  seedGiveawayTabOnce();
})();

// Whatnot only ever registers its GetSellerLiveShop query for a given tab (Angebote/Auktion/
// Giveaways/Sofortkauf) once the seller has actually clicked that tab at least once — bridge.js's
// ensureAllListingsLoaded() works around this for the AUCTION/GIVEAWAY/BUY_IT_NOW GraphQL calls
// themselves, but a real click still seems to make the underlying data land more reliably (e.g. the
// commerce/auction Phoenix channel joins), so this does one real, synthetic click on "Giveaways"
// then back to "Auction" shortly after page load, purely as a best-effort nudge. NEVER a
// requirement — bridge.js's own GraphQL-based loading is the actual fallback if this does nothing
// or the buttons aren't found.
//
// This clicks a REAL native Whatnot tab button, which is exactly what previously crashed the page
// outright with an uncaught React error #418 (hydration mismatch tearing down the whole React
// tree) — see switchNativeTab()'s comment above, which is why THAT function is a no-op. Delaying a
// few seconds past page load (letting React finish its own initial hydration first) and wrapping
// every step in try/catch is meant to avoid repeating that, but this has NOT been verified safe
// against a fresh, truly-empty show live — watch for the same crash if it ever recurs.
function seedGiveawayTabOnce() {
  setTimeout(() => {
    try {
      const giveawaysBtn = document.querySelector('[data-wn-action="seller_live.shop.tab.giveaways"]');
      if (!giveawaysBtn) { console.warn('[Whatnot Helper] Giveaways-Tab nicht gefunden'); return; }
      giveawaysBtn.click();
      setTimeout(() => {
        try {
          const auctionBtn = document.querySelector('[data-wn-action="seller_live.shop.tab.auction"]');
          if (!auctionBtn) { console.warn('[Whatnot Helper] Auktion-Tab nicht gefunden'); return; }
          auctionBtn.click();
        } catch (e) {
          console.warn('[Whatnot Helper] Zurückwechseln zum Auktion-Tab fehlgeschlagen:', e);
        }
      }, 800);
    } catch (e) {
      console.warn('[Whatnot Helper] Wechsel zum Giveaways-Tab fehlgeschlagen:', e);
    }
  }, 3000);
}

// --- Stream Deck Bridge -----------------------------------------------
// Verbindet sich mit dem lokalen WebSocket-Server, den das Stream-Deck-Plugin
// startet (siehe streamdeck-plugin/src/bridge/ws-server.ts, Port 9271).
// Ein Tastendruck füllt hier nur das Preis-/Versand-Feld, gestartet wird die
// Auktion weiterhin bewusst manuell über den zweistufigen "Bestätigen"-Button.
(() => {
  const SD_BRIDGE_URL = 'ws://localhost:9271';
  const RECONNECT_DELAY_MS = 3000;
  let socket = null;

  function connect() {
    try {
      socket = new WebSocket(SD_BRIDGE_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      $('dotSd').classList.add('ok');
      sdSocket = socket;
      lastSentOverlayState = null; // resend current state after (re)connect, not just on next change
      lastSentArticleState = null;
      sendOverlayState();
      sendArticleState();
    });

    socket.addEventListener('close', () => {
      $('dotSd').classList.remove('ok');
      sdSocket = null;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket.close();
    });

    socket.addEventListener('message', (ev) => {
      try {
        const message = JSON.parse(ev.data);
        if (message?.requestId) {
          handleRequest(message);
        } else {
          handleCommand(message);
        }
      } catch (err) {
        console.warn('[Whatnot Helper] Ungültiges Kommando vom Stream Deck:', err);
      }
    });
  }

  function scheduleReconnect() {
    setTimeout(connect, RECONNECT_DELAY_MS);
  }

  // Requests expect a reply (plugin is asking us for live data, e.g. for a property inspector
  // dropdown) — distinct from one-way commands like setStartPrice that just update the UI.
  async function handleRequest(request) {
    let result;
    try {
      switch (request.type) {
        case 'getShippingProfiles':
          result = profiles.length
            ? profiles
            : await call('getShippingProfiles', current()?.category?.id ?? current()?.categoryId);
          break;
        case 'getListings':
          result = listings.length ? listings : await call('getListings');
          break;
        default:
          throw new Error(`Unbekannter Request-Typ: ${request.type}`);
      }
      socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, result }));
    } catch (err) {
      socket.send(JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: String(err?.message || err)
      }));
    }
  }

  function handleCommand(command) {
    if (!command || typeof command.type !== 'string') return;

    switch (command.type) {
      case 'setStartPrice': {
        if (!selectListingForType(false)) { $('meta').textContent = 'Kein Auktionsartikel vorhanden'; return; }
        const price = parseFloat(command.price);
        if (Number.isNaN(price)) return;
        $('price').value = price.toFixed(2);
        $('price').dataset.touched = '1';
        schedulePatchListing();
        pulseBar();
        break;
      }
      case 'setShippingMethod': {
        // target defaults to "auction" for older plugin builds that don't send it yet (see
        // AdjustShippingMethod/CurrentShippingDisplay's `target` setting in the Stream Deck plugin).
        const wantGiveaway = command.target === 'giveaway';
        if (!selectListingForType(wantGiveaway)) {
          $('meta').textContent = wantGiveaway ? 'Kein Giveaway-Artikel vorhanden' : 'Kein Auktionsartikel vorhanden';
          return;
        }
        const label = String(command.label ?? '').trim().toLowerCase();
        const match = profiles.find(p => p.name.toLowerCase() === label)
          ?? profiles.find(p => p.name.toLowerCase().includes(label));
        if (!match) {
          $('meta').textContent = `Kein Versandprofil für „${command.label}" gefunden`;
          return;
        }
        $('profile').dataset.touched = '1';
        $('profile').value = match.id;
        render();
        schedulePatchListing();
        pulseBar();
        break;
      }
      case 'setAuctionDuration': {
        if (!selectListingForType(false)) { $('meta').textContent = 'Kein Auktionsartikel vorhanden'; return; }
        const seconds = parseInt(command.seconds, 10);
        if (!Number.isFinite(seconds)) return;
        const select = $('duration');
        const options = Array.from(select.options);
        const exact = options.find(o => o.value === String(seconds));
        if (exact) {
          select.value = exact.value;
        } else {
          // No exact preset for this duration — fall back to the closest available option
          // rather than silently ignoring the Stream Deck press.
          const nearest = options.reduce((a, b) =>
            Math.abs(parseInt(b.value, 10) - seconds) < Math.abs(parseInt(a.value, 10) - seconds) ? b : a
          );
          select.value = nearest.value;
          $('meta').textContent = `Keine ${seconds}s-Option – nächstliegender Wert (${nearest.value}s) gewählt`;
        }
        saveListingPref(current()?.id, { durationSeconds: +select.value });
        pulseBar();
        break;
      }
      case 'selectListing': {
        const match = listings.find(l => l.id === command.listingId);
        if (!match) {
          $('meta').textContent = `Artikel-ID „${command.listingId}" nicht in der aktuellen Liste gefunden`;
          return;
        }
        selectListingById(match.id);
        pulseBar();
        break;
      }
      case 'startAuction': {
        if (!selectListingForType(false)) { $('meta').textContent = 'Kein Auktionsartikel vorhanden'; return; }
        // Optional per-key configured bump time (Start Auction button's own settings) — applied
        // right before starting, same nearest-preset fallback as setAuctionDuration, so a value
        // that doesn't exactly match one of the <select>'s options still lands on the closest one
        // instead of being silently ignored.
        const bumpSeconds = parseInt(command.bumpSeconds, 10);
        if (Number.isFinite(bumpSeconds)) {
          const select = $('bump');
          const options = Array.from(select.options);
          const exact = options.find(o => o.value === String(bumpSeconds));
          select.value = exact ? exact.value : options.reduce((a, b) =>
            Math.abs(parseInt(b.value, 10) - bumpSeconds) < Math.abs(parseInt(a.value, 10) - bumpSeconds) ? b : a
          ).value;
          saveListingPref(current()?.id, { bumpSeconds: +select.value });
        }
        startAuctionFromCurrentState()
          .then(() => { $('meta').textContent = 'Auktion gestartet ✓'; pulseBar(); })
          .catch((e) => { $('meta').textContent = 'Fehler beim Auktionsstart: ' + e.message; });
        break;
      }
      case 'setAuctionMode': {
        if (!selectListingForType(false)) { $('meta').textContent = 'Kein Auktionsartikel vorhanden'; return; }
        const mode = command.mode === 'suddenDeath' ? 'suddenDeath' : 'standard';
        $('mode').value = mode;
        saveListingPref(current()?.id, { mode });
        pulseBar();
        break;
      }
      case 'startGiveaway': {
        if (!selectListingForType(true)) { $('meta').textContent = 'Kein Giveaway-Artikel vorhanden'; return; }
        startGiveawayFromCurrentState()
          .then(() => { $('meta').textContent = 'Giveaway gestartet ✓'; pulseBar(); })
          .catch((e) => { $('meta').textContent = 'Fehler beim Giveaway-Start: ' + e.message; });
        break;
      }
      case 'drawGiveawayWinner': {
        if (!selectListingForType(true)) { $('meta').textContent = 'Kein Giveaway-Artikel vorhanden'; return; }
        drawGiveawayWinnerFromCurrentState()
          .then(() => { pulseBar(); })
          .catch((e) => { $('meta').textContent = 'Fehler beim Gewinner ziehen: ' + e.message; });
        break;
      }
      case 'pinListing': {
        if (!selectListingForType(false)) { $('meta').textContent = 'Kein Auktionsartikel vorhanden'; return; }
        pinListingFromCurrentState()
          .then(() => { $('meta').textContent = 'Angepinnt ✓'; pulseBar(); })
          .catch((e) => { $('meta').textContent = 'Fehler beim Anpinnen: ' + e.message; });
        break;
      }
      case 'unpinListing': {
        if (!selectListingForType(false)) { $('meta').textContent = 'Kein Auktionsartikel vorhanden'; return; }
        unpinListingFromCurrentState()
          .then(() => { $('meta').textContent = 'Abgepinnt'; pulseBar(); })
          .catch((e) => { $('meta').textContent = 'Fehler beim Abpinnen: ' + e.message; });
        break;
      }
      case 'cycleArticle': {
        // Cycles to the NEXT listing of the same type (auction/giveaway), wrapping around — if only
        // one exists, it lands back on itself. Always switches the overlay's own selection too (see
        // selectListingById), so the Current Article Display tile and the bar's dropdown never
        // disagree about which one is "current" for that type.
        const wantGiveaway = command.kind === 'giveaway';
        const ofType = listings.filter(x => isGiveaway(x) === wantGiveaway);
        if (ofType.length === 0) {
          $('meta').textContent = wantGiveaway ? 'Kein Giveaway-Artikel vorhanden' : 'Kein Auktionsartikel vorhanden';
          return;
        }
        const current_ = resolveListingForType(wantGiveaway);
        const idx = ofType.findIndex(x => x.id === current_?.id);
        const next = ofType[(idx + 1) % ofType.length];
        selectListingById(next.id);
        pulseBar();
        break;
      }
      default:
        console.warn('[Whatnot Helper] Unbekanntes Kommando:', command.type);
    }
  }

  connect();
})();
