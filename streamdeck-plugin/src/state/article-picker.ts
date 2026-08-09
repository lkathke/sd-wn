import streamDeck from "@elgato/streamdeck";

import { requestFromExtension } from "../bridge/ws-server";

export type Listing = {
	id: string;
	title: string;
	imageUrl?: string;
};

// A standard Stream Deck page is 3x5 = 15 keys; two are reserved for prev/next navigation.
const PAGE_SIZE = 13;
// Listings change more often mid-show than shipping profiles, so refresh more eagerly.
const CACHE_TTL_MS = 30 * 1000;

let cache: Listing[] = [];
let page = 0;
let lastFetch = 0;
let inFlight: Promise<Listing[]> | null = null;

/**
 * bridge.js's getListings() returns whatever shape the Apollo cache happens to hold for a
 * ListingNode, which depends on which GraphQL queries the Whatnot app has run so far — untested
 * against a live show, so this defensively tries a few plausible field names for the thumbnail
 * instead of assuming one exact shape.
 */
function extractImageUrl(raw: Record<string, unknown>): string | undefined {
	const images = raw.images;
	const first = Array.isArray(images) ? images[0] : (raw.image ?? raw.thumbnail);
	if (!first) return undefined;
	if (typeof first === "string") return first;
	if (typeof first === "object") {
		const obj = first as Record<string, unknown>;
		const url = obj.url ?? obj.imageUrl ?? obj.src ?? obj.href;
		return typeof url === "string" ? url : undefined;
	}
	return undefined;
}

function extractTitle(raw: Record<string, unknown>): string {
	return typeof raw.title === "string" && raw.title.length > 0 ? raw.title : "Ohne Titel";
}

function extractId(raw: Record<string, unknown>): string {
	return String(raw.id ?? raw.listingId ?? raw.numericId ?? "");
}

/**
 * Fetches the seller's current live listings via the Chrome extension, caching briefly so that
 * many slot keys appearing at once (a whole page rendering) don't each fire their own request.
 *
 * Never throws: if the extension isn't connected yet (e.g. right after Stream Deck starts, before
 * Chrome has loaded the Whatnot page), this logs a warning and resolves with whatever's cached
 * (possibly empty) instead — an uncaught rejection here would crash the entire plugin process.
 */
export async function ensureListingsLoaded(force = false): Promise<Listing[]> {
	const stale = Date.now() - lastFetch > CACHE_TTL_MS;
	if (!force && !stale && cache.length > 0) return cache;
	if (inFlight) return inFlight;

	inFlight = requestFromExtension<Record<string, unknown>[]>("getListings")
		.then((raw) => {
			cache = raw.map((l) => ({ id: extractId(l), title: extractTitle(l), imageUrl: extractImageUrl(l) }));
			lastFetch = Date.now();
			return cache;
		})
		.catch((err) => {
			streamDeck.logger.warn(`Could not load listings: ${String(err)}`);
			return cache;
		})
		.finally(() => {
			inFlight = null;
		});

	return inFlight;
}

export function getArticlePageSize(): number {
	return PAGE_SIZE;
}

export function getArticlePage(): number {
	return page;
}

export function getArticleMaxPage(): number {
	return Math.max(0, Math.ceil(cache.length / PAGE_SIZE) - 1);
}

/** Clamps and sets the current page, returning the resulting (clamped) page number. */
export function setArticlePage(candidate: number): number {
	page = Math.min(Math.max(0, candidate), getArticleMaxPage());
	return page;
}

export function getListingAtSlot(slotIndex: number): Listing | undefined {
	return cache[page * PAGE_SIZE + slotIndex];
}
