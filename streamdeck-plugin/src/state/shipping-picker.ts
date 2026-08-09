import streamDeck from "@elgato/streamdeck";

import { requestFromExtension } from "../bridge/ws-server";

export type ShippingProfile = { id: string; name: string };

// A standard Stream Deck page is 3x5 = 15 keys; two are reserved for prev/next navigation.
const PAGE_SIZE = 13;
const CACHE_TTL_MS = 2 * 60 * 1000;

let cache: ShippingProfile[] = [];
let page = 0;
let lastFetch = 0;
let inFlight: Promise<ShippingProfile[]> | null = null;

/**
 * Fetches the seller's real shipping profiles via the Chrome extension, caching briefly so that
 * many slot keys appearing at once (a whole page rendering) don't each fire their own request.
 *
 * Never throws: if the extension isn't connected yet (e.g. right after Stream Deck starts, before
 * Chrome has loaded the Whatnot page), this logs a warning and resolves with whatever's cached
 * (possibly empty) instead — an uncaught rejection here would crash the entire plugin process.
 */
export async function ensureShippingProfilesLoaded(force = false): Promise<ShippingProfile[]> {
	const stale = Date.now() - lastFetch > CACHE_TTL_MS;
	if (!force && !stale && cache.length > 0) return cache;
	if (inFlight) return inFlight;

	inFlight = requestFromExtension<ShippingProfile[]>("getShippingProfiles")
		.then((profiles) => {
			cache = profiles;
			lastFetch = Date.now();
			return cache;
		})
		.catch((err) => {
			streamDeck.logger.warn(`Could not load shipping profiles: ${String(err)}`);
			return cache;
		})
		.finally(() => {
			inFlight = null;
		});

	return inFlight;
}

export function getShippingPageSize(): number {
	return PAGE_SIZE;
}

export function getShippingPage(): number {
	return page;
}

export function getShippingMaxPage(): number {
	return Math.max(0, Math.ceil(cache.length / PAGE_SIZE) - 1);
}

/** Clamps and sets the current page, returning the resulting (clamped) page number. */
export function setShippingPage(candidate: number): number {
	page = Math.min(Math.max(0, candidate), getShippingMaxPage());
	return page;
}

export function getShippingProfileAtSlot(slotIndex: number): ShippingProfile | undefined {
	return cache[page * PAGE_SIZE + slotIndex];
}
