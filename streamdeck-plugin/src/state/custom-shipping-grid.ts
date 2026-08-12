import streamDeck from "@elgato/streamdeck";

import { requestFromExtension } from "../bridge/ws-server";

// Raw shape bridge.js's getShippingProfiles() returns per profile (see whatnot-helper/src/
// bridge.js's ShippingProfile GraphQL fragment) — wider than shipping-picker.ts's own
// {id, name} type since this grid needs to filter/sort by fields that one doesn't.
type RawShippingProfile = {
	id: string;
	name: string;
	source?: "suggested" | "custom";
	weightAmount?: number;
	weightScale?: string;
};

export type CustomShippingProfile = { id: string; name: string };

// Grams-per-unit for known scale strings. UNVERIFIED against the real GraphQL enum's actual
// values live — bridge.js's fragment requests weightScale but no session so far has printed one to
// confirm the exact casing/spelling Whatnot uses. Falls back to treating an unrecognized scale as
// already grams (multiplier 1), which still sorts same-scale profiles correctly relative to each
// other even if that specific assumption is wrong — only cross-scale ordering would be affected.
const GRAMS_PER_UNIT: Record<string, number> = {
	gram: 1,
	grams: 1,
	g: 1,
	kilogram: 1000,
	kilograms: 1000,
	kg: 1000,
	ounce: 28.35,
	ounces: 28.35,
	oz: 28.35,
	pound: 453.6,
	pounds: 453.6,
	lb: 453.6,
	lbs: 453.6
};

function toGrams(amount: number | undefined, scale: string | undefined): number {
	if (amount == null) return Number.POSITIVE_INFINITY; // profiles with no defined weight sort last
	const multiplier = scale ? (GRAMS_PER_UNIT[scale.toLowerCase()] ?? 1) : 1;
	return amount * multiplier;
}

const CACHE_TTL_MS = 2 * 60 * 1000;

let cache: CustomShippingProfile[] = [];
let lastFetch = 0;
let inFlight: Promise<CustomShippingProfile[]> | null = null;

/**
 * Fetches the seller's own custom shipping profiles (excludes Whatnot's suggested/ready-made
 * ones — see bridge.js's getShippingProfiles(), which tags each with `source: "custom" |
 * "suggested"`), sorted by weight ascending. Meant for a grid of ~14 keys placed directly in a
 * Stream Deck Folder (no pagination/nav needed) showing every custom profile that fits, lightest
 * first.
 *
 * Never throws — same reasoning as shipping-picker.ts's ensureShippingProfilesLoaded(): an
 * uncaught rejection here would crash the entire plugin process.
 */
export async function ensureCustomShippingProfilesLoaded(force = false): Promise<CustomShippingProfile[]> {
	const stale = Date.now() - lastFetch > CACHE_TTL_MS;
	if (!force && !stale && cache.length > 0) return cache;
	if (inFlight) return inFlight;

	inFlight = requestFromExtension<RawShippingProfile[]>("getShippingProfiles")
		.then((profiles) => {
			cache = profiles
				.filter((p) => p.source === "custom")
				.sort((a, b) => toGrams(a.weightAmount, a.weightScale) - toGrams(b.weightAmount, b.weightScale))
				.map((p) => ({ id: p.id, name: p.name }));
			lastFetch = Date.now();
			return cache;
		})
		.catch((err) => {
			streamDeck.logger.warn(`Could not load custom shipping profiles: ${String(err)}`);
			return cache;
		})
		.finally(() => {
			inFlight = null;
		});

	return inFlight;
}

export function getCustomShippingProfileAtSlot(slotIndex: number): CustomShippingProfile | undefined {
	return cache[slotIndex];
}
