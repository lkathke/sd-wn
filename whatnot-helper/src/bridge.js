(() => {
  'use strict';
  if (window.__wnBridge) return;

  const state = {
    gql: null,            // { url, headers } aus einem echten App-Request
    ops: {},               // operationName -> query-Text
    // "commerce:<id>" (start_auction/pin_product) and "auction:<id>" (start_giveaway/
    // select_giveaway_winner) turned out live to run over two DIFFERENT physical WebSocket
    // connections — "commerce:<id>" over /services/auction/socket, "auction:<id>" over
    // /services/live/socket (confirmed by inspecting each frame's actual `this.url` at send time;
    // the original single-`state.socket` design and the "same socket, two topics" comment below
    // assumed one shared connection, which silently sent auction-topic pushes down the wrong
    // connection). Tracked per-channel now, same shape/keys as `channels` below.
    sockets: { commerce: null, auction: null },
    // Each topic has its own joinRef, which goes into every push() frame for that channel.
    channels: { commerce: null, auction: null }, // -> { topic, joinRef }
    ref: 900000,           // bewusst weit weg vom Zähler der App
    pending: new Map(),
  };
  window.__wnBridge = state;

  const origFetch = window.fetch;

  window.fetch = function (input, init) {
    try { harvest(input, init); } catch {}
    return origFetch.apply(this, arguments);
  };

  function harvest(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (!url || !/graphql/i.test(url)) return;
    const body = init?.body;
    if (typeof body !== 'string') return;

    if (!state.gql) {
      const headers = {};
      new Headers(init?.headers || {}).forEach((v, k) => { headers[k] = v; });
      delete headers['content-length'];
      state.gql = { url, headers };
    }
    const parsed = JSON.parse(body);
    for (const op of (Array.isArray(parsed) ? parsed : [parsed])) {
      if (op.operationName && op.query) state.ops[op.operationName] = op.query;
    }
  }

  async function gql(operationName, variables, fallbackQuery) {
    if (!state.gql) throw new Error('Noch kein GraphQL-Request der App gesehen.');
    const query = state.ops[operationName] || fallbackQuery;
    if (!query) throw new Error(`Kein Query-Text für ${operationName}.`);

    const res = await origFetch(state.gql.url, {
      method: 'POST',
      credentials: 'include',
      headers: { ...state.gql.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ operationName, query, variables }),
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join('; '));
    return json.data;
  }

  const FRAG = `
fragment ShippingProfile on ShippingProfileNode {
  id name hasCompatibleShippingPackage
  weightAmount weightScale weightName
  length width height dimensionScale
  bundleConfiguration {
    maxBundleSize
    boxDimensions { length width height scale }
    flatRateBoxId
  }
}`;

  const Q_SUGGESTED = `
query GetSuggestedShippingProfiles($categoryId: ID) {
  suggestedShippingProfiles(categoryId: $categoryId) {
    header
    profiles { ...ShippingProfile }
  }
  me { id shouldCollectItemDimensions }
}${FRAG}`;

  const Q_CUSTOM = `
query GetCustomShippingProfiles($after: String, $first: Int) {
  customShippingProfiles(after: $after, first: $first) {
    pageInfo { hasNextPage endCursor }
    edges { node { ...ShippingProfile } }
  }
}${FRAG}`;

  // shippingProfile sits under `product`, not top-level on ListingNode — confirmed live via
  // readListing()'s response shape (see toListingInput's comment). This fallback mutation query
  // (only used until the app's own UpdateListing gets harvested at least once, see gql()) had the
  // same bug at the response-selection level: requesting top-level `shippingProfile` here is an
  // invalid field and made every patchListing() call fail outright with a GraphQL validation error
  // whenever no real UpdateListing had been harvested yet — silently breaking the debounced
  // auto-save in overlay.js (see schedulePatchListing) until the seller happened to save a listing
  // edit through Whatnot's own UI first.
  const M_UPDATE = `
mutation UpdateListing($input: ListingInput!) {
  updateListing2(input: $input) {
    listingNode {
      id title quantity
      price { amount currency }
      product { shippingProfile { id name } }
    }
    error
  }
}`;

  async function getShippingProfiles(categoryId) {
    const suggested = await gql('GetSuggestedShippingProfiles', { categoryId }, Q_SUGGESTED)
      .then(d => (d.suggestedShippingProfiles || []).flatMap(
        g => (g.profiles || []).map(p => ({ ...p, group: g.header, source: 'suggested' }))
      ))
      .catch(() => []);

    const custom = [];
    let after = null;
    try {
      for (let page = 0; page < 25; page++) {
        const d = await gql('GetCustomShippingProfiles', { after, first: 50 }, Q_CUSTOM);
        const conn = d.customShippingProfiles;
        custom.push(...conn.edges.map(e => ({ ...e.node, group: 'Eigene Profile', source: 'custom' })));
        if (!conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
    } catch {
      // Same startup race as the suggested-profiles branch above (no GraphQL request harvested
      // yet) — fail soft instead of throwing, so a single early call doesn't take down whatever
      // async flow is awaiting this (see overlay.js's ensureProfilesLoaded(), which retries).
    }

    const seen = new Set();
    return [...suggested, ...custom].filter(p => !seen.has(p.id) && seen.add(p.id));
  }

  function cacheSnapshot() {
    return window.__APOLLO_CLIENT__?.cache?.extract?.() || {};
  }

  // Apollo registers a query's document (the parsed GraphQL AST) in queryManager.queries as soon
  // as some component in the app mounts a useQuery/watchQuery for it — even if that query is
  // currently skipped or has never actually fired a network request. Confirmed live: on the
  // seller live-dashboard, GetSellerLiveListing's document is already present here right after a
  // fresh page load, well before ever clicking "Artikel bearbeiten". That means we don't need to
  // wait for (or trigger) a real fetch() to harvest its query text — we can hand this document
  // straight to client.query() ourselves. Falls back to the fetch-harvest path in gql() when the
  // document isn't registered yet (e.g. right after login, before that component has mounted).
  function findQueryDocument(operationName) {
    const qm = window.__APOLLO_CLIENT__?.queryManager;
    if (!qm) return null;
    for (const q of qm.queries.values()) {
      if (q.document?.definitions?.[0]?.name?.value === operationName) return q.document;
    }
    return null;
  }

  function deref(snap, v) {
    if (Array.isArray(v)) return v.map(x => deref(snap, x));
    if (v && typeof v === 'object') {
      if (v.__ref) return deref(snap, snap[v.__ref]);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deref(snap, x)]));
    }
    return v;
  }

  function getListings() {
    const snap = cacheSnapshot();
    return Object.entries(snap)
      .filter(([k]) => k.startsWith('ListingNode:'))
      .map(([, v]) => deref(snap, v));
  }

  // The dashboard only fires GetSellerLiveShop (the query behind the Angebote/Auktion/Giveaways/
  // Sofortkauf tab list) for whichever tab's transactionTypes the seller has actually clicked —
  // confirmed live: a GIVEAWAY listing was completely absent from getListings() until the
  // "Giveaways" tab was clicked once, because no ListingNode for it had ever entered the Apollo
  // cache. Proactively firing this query for every transaction type (using the same document Apollo
  // already has registered, same approach as readListing()'s findQueryDocument) means the overlay's
  // listing dropdown is complete from the start, without requiring that manual click first.
  // "BUY_IT_NOW" (not "BUY_NOW"/"FIXED_PRICE") confirmed live from the real query fired when
  // clicking "Sofortkauf" — the enum rejects both those guesses with a GraphQL validation error.
  const SHOP_TRANSACTION_TYPES = ['AUCTION', 'GIVEAWAY', 'BUY_IT_NOW'];

  async function ensureAllListingsLoaded(livestreamId) {
    const client = window.__APOLLO_CLIENT__;
    const doc = findQueryDocument('GetSellerLiveShop');
    if (!client || !doc) return; // same startup race as everywhere else here — caller retries
    await Promise.all(SHOP_TRANSACTION_TYPES.map((t) =>
      client.query({
        query: doc,
        variables: {
          livestreamId, tab: 'ACTIVE', transactionTypes: [t], query: '',
          first: 24, after: null, includeAuctionListFields: true, includeActiveListingFields: true,
        },
        fetchPolicy: 'network-only',
      }).catch(() => {}) // one tab's type failing (e.g. server-side quirk) shouldn't block the others
    ));
  }

  function toListingInput(l, patch = {}) {
    return {
      id: String(l.listingId ?? l.numericId ?? l.id),
      title: l.title,
      description: l.description ?? '',
      transactionType: l.transactionType,
      transactionProps: {
        giveaway: {
          onlyDomestic: true, onlyFollowers: false,
          buyerAppreciation: false, buyerAppreciationSellerRules: null,
        },
        isOfferable: !!l.isOfferable,
        isBreak: !!l.isBreak,
        isBreakSpot: !!l.isBreakSpot,
      },
      price: { amount: l.price.amount, currency: l.price.currency },
      quantity: l.quantity,
      // shippingProfile sits under `product` in GetSellerLiveListing's response shape (the only
      // caller of toListingInput passes that shape via readListing()), not at the top level —
      // confirmed live. Reading the wrong path here silently wiped the listing's shipping profile
      // on every patchListing() call that didn't explicitly set one (e.g. every Set Start Price
      // press), since UpdateListing replaces the whole listing rather than merging.
      shippingProfileId: l.product?.shippingProfile?.id ?? l.shippingProfile?.id ?? null,
      hazmatType: l.hazmatType ?? 'NOT_HAZMAT',
      images: (l.images || []).map(i => ({ id: i.id, key: i.key })),
      productAttributeValues: l.productAttributeValues ?? [],
      variants: null,
      ...patch,
    };
  }

  async function readListing(globalId, livestreamId) {
    const client = window.__APOLLO_CLIENT__;
    const doc = findQueryDocument('GetSellerLiveListing');
    const d = client && doc
      ? (await client.query({
          query: doc,
          variables: { id: globalId, livestreamId },
          fetchPolicy: 'network-only',
        })).data
      : await gql('GetSellerLiveListing', { id: globalId, livestreamId });
    // Confirmed live: this query's response comes back under "getListing", not "listing"/"node" —
    // the fallback still covers it since it's the only key, but name it explicitly for clarity.
    return d.getListing ?? d.listing ?? d.node ?? Object.values(d)[0];
  }

  async function patchListing(globalId, livestreamId, patch) {
    const current = await readListing(globalId, livestreamId);
    const input = toListingInput(current, patch);
    const d = await gql('UpdateListing', { input }, M_UPDATE);
    if (d.updateListing2?.error) throw new Error(d.updateListing2.error);
    await window.__APOLLO_CLIENT__?.refetchQueries({ include: ['GetSellerLiveListing'] });
    return d.updateListing2.listingNode;
  }

  const setShippingProfile = (gid, lsid, profileId) =>
    patchListing(gid, lsid, { shippingProfileId: profileId });

  const setStartPrice = (gid, lsid, cents) =>
    patchListing(gid, lsid, { price: { amount: cents, currency: 'EUR' } });

  const origSend = WebSocket.prototype.send;
  const hooked = new WeakSet();

  // Events broadcast on the auction socket (not replies to our own pushes) that the overlay wants
  // to react to live — giveaway progress has no other way to reach us since there's no polling
  // endpoint for it.
  const FORWARDED_EVENTS = new Set([
    'giveaway_started', 'giveaway_entry_count_updated', 'giveaway_eligibility_updated',
    'giveaway_won', 'giveaway_ended_without_winner',
  ]);

  // Matches both known Phoenix endpoints — /services/auction/socket (commerce:<id> topic) and
  // /services/live/socket (auction:<id> topic, despite the topic's name) — confirmed live via each
  // frame's actual `this.url`. Broad enough to survive a third endpoint showing up the same way,
  // since the topic-prefix check below is the real filter; this is just to avoid touching every
  // unrelated WebSocket on the page (e.g. Agora's video sockets).
  const AUCTION_SOCKET_URL_RE = /\/services\/(?:auction|live)\/socket/;

  WebSocket.prototype.send = function (data) {
    try {
      if (typeof data === 'string' && AUCTION_SOCKET_URL_RE.test(this.url)) {
        const f = JSON.parse(data);
        if (Array.isArray(f) && f.length === 5) {
          const [joinRef, , topic] = f;
          attach(this);
          // Learn the joinRef (and which physical socket to push on) from ANY outgoing frame on a
          // commerce:/auction: topic, not only an explicit "phx_join" one — confirmed live the
          // app's own "auction:<id>" join never actually shows up as a phx_join event through this
          // patch, yet every subsequent push it sends on that topic (start_giveaway,
          // select_giveaway_winner, ...) carries the same joinRef regardless. Opportunistically
          // capturing it from those pushes too means we still learn the right joinRef/socket even
          // though we apparently never see the join itself.
          const t = String(topic);
          if (t.startsWith('commerce:')) { state.channels.commerce = { topic: t, joinRef }; state.sockets.commerce = this; }
          else if (t.startsWith('auction:')) { state.channels.auction = { topic: t, joinRef }; state.sockets.auction = this; }
        }
      }
    } catch {}
    return origSend.apply(this, arguments);
  };

  function attach(ws) {
    if (hooked.has(ws)) return;
    hooked.add(ws);
    ws.addEventListener('message', (ev) => {
      try {
        const f = JSON.parse(ev.data);
        if (!Array.isArray(f) || f.length !== 5) return;
        const [, ref, , event, payload] = f;
        if (event === 'phx_reply') {
          const p = state.pending.get(ref);
          if (p) { state.pending.delete(ref); p(payload); }
          return;
        }
        if (FORWARDED_EVENTS.has(event)) {
          window.postMessage({ __wn: 'event', event, payload }, location.origin);
        }
      } catch {}
    });
  }

  function push(channel, event, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ws = state.sockets[channel];
      const ch = state.channels[channel];
      if (!ws || ws.readyState !== WebSocket.OPEN || !ch) {
        return reject(new Error('Auktions-Socket nicht verbunden – läuft die Show?'));
      }
      const ref = String(state.ref++);
      state.pending.set(ref, (reply) =>
        reply?.status === 'ok' ? resolve(reply.response) : reject(new Error(JSON.stringify(reply)))
      );
      origSend.call(ws, JSON.stringify([ch.joinRef, ref, ch.topic, event, payload]));
      setTimeout(() => {
        if (state.pending.delete(ref)) reject(new Error('Timeout bei ' + event));
      }, timeoutMs);
    });
  }

  const AUCTION_MODES = {
    standard: { isSuddenDeath: false, isDutchAuction: false },
    suddenDeath: { isSuddenDeath: true, isDutchAuction: false },
  };

  function startAuction({
    productUuid, cents, currency = 'EUR',
    durationSeconds = 30, bumpThresholdSeconds = 10,
    mode = 'standard',
  }) {
    const m = AUCTION_MODES[mode];
    if (!m) throw new Error(`Unbekannter Auktionsmodus: ${mode}`);
    const money = { amount: cents, amountSafe: cents, currency };
    return push('commerce', 'start_auction', {
      productId: productUuid,
      durationSeconds,
      auctionMinimumPrice: money,
      ...m,
      bumpThresholdSeconds,
      dutchAuctionInfo: { startPrice: money, floorPrice: null },
      slo_stories: [{ key: crypto.randomUUID(), story: 'story_live_auction_start' }],
    });
  }

  const GIVEAWAY_ELIGIBILITY = {
    everyone: { onlyFollowers: false, buyerAppreciation: false },
    followersOnly: { onlyFollowers: true, buyerAppreciation: false },
    buyerAppreciation: { onlyFollowers: false, buyerAppreciation: true },
  };

  async function configureGiveaway(cacheId, livestreamId, {
    eligibility = 'everyone',
    internationalShipping = false,
    sellerRules = null,
  } = {}) {
    const e = GIVEAWAY_ELIGIBILITY[eligibility];
    if (!e) throw new Error(`Unbekannte Eligibility: ${eligibility}`);

    return patchListing(cacheId, livestreamId, {
      transactionType: 'GIVEAWAY',
      quantity: 1, // Pflicht bei Giveaways
      transactionProps: {
        giveaway: {
          onlyFollowers: e.onlyFollowers,
          buyerAppreciation: e.buyerAppreciation,
          buyerAppreciationSellerRules: e.buyerAppreciation ? sellerRules : null,
          onlyDomestic: !internationalShipping, // invertiert zur "International Shipping"-Checkbox
        },
        isOfferable: false, isBreak: false, isBreakSpot: false,
      },
    });
  }

  async function startGiveaway(productUuid) {
    // Do NOT pin the product ourselves first — confirmed live the server actively rejects that
    // with a 400 "CANNOT_PIN_GIVEAWAY" ("Cannot start the giveaway through pinning"). start_giveaway
    // apparently pins internally on its own; our own explicit pin_product push before it (as the
    // comment here used to claim was required) was actually the thing silently breaking every
    // giveaway start.
    return push('auction', 'start_giveaway', {
      productId: productUuid,
      slo_stories: [{ key: crypto.randomUUID(), story: 'story_start_giveaway' }],
    });
  }

  const drawGiveawayWinner = (productUuid) =>
    push('auction', 'select_giveaway_winner', {
      productId: productUuid,
      slo_stories: [{ key: crypto.randomUUID(), story: 'story_giveaway_seller_select_winner' }],
    });

  // Pins/unpins a listing so its price/shipping/image show up as the live "featured" preview
  // buyers see, independent of whether an auction has actually started — same commerce-topic push
  // startGiveaway() above already relies on (a giveaway can't run unpinned either).
  const pinProduct = (productUuid) => push('commerce', 'pin_product', { productId: productUuid });
  const unpinProduct = (productUuid) => push('commerce', 'unpin_product', { productId: productUuid });

  const api = {
    getShippingProfiles, getListings, getListingDetails: readListing, setShippingProfile, setStartPrice, startAuction,
    configureGiveaway, startGiveaway, drawGiveawayWinner, pinProduct, unpinProduct, patchListing,
    ensureAllListingsLoaded,
    status: () => ({
      gqlReady: !!state.gql,
      socketReady: state.sockets.commerce?.readyState === 1,
      topic: state.channels.commerce?.topic ?? null,
    }),
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.__wn !== 'req') return;
    const { id, method, args } = e.data;
    try {
      const result = await api[method](...(args || []));
      window.postMessage({ __wn: 'res', id, ok: true, result }, location.origin);
    } catch (err) {
      window.postMessage({ __wn: 'res', id, ok: false, error: String(err?.message || err) }, location.origin);
    }
  });
})();
