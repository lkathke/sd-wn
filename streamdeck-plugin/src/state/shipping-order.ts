import streamDeck from "@elgato/streamdeck";

export type ShippingOrderEntry = { name: string; enabled: boolean };
type GlobalSettings = { shippingOrder?: ShippingOrderEntry[] };

export async function getShippingOrder(): Promise<ShippingOrderEntry[]> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	return settings.shippingOrder ?? [];
}

export async function setShippingOrder(order: ShippingOrderEntry[]): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	await streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...settings, shippingOrder: order });
}

/**
 * Merges the saved order with the live profile list: profiles the user already ordered keep their
 * saved position and enabled state; profiles seen for the first time are appended as enabled.
 * Profiles that no longer exist live are dropped. Used both to render the config UI (with live
 * data) and to keep the saved order in sync as the seller's real profile list changes.
 */
export function mergeWithLiveProfiles(saved: ShippingOrderEntry[], liveNames: string[]): ShippingOrderEntry[] {
	const stillLive = saved.filter((entry) => liveNames.includes(entry.name));
	const knownNames = new Set(stillLive.map((entry) => entry.name));
	const newOnes = liveNames.filter((name) => !knownNames.has(name)).map((name) => ({ name, enabled: true }));
	return [...stillLive, ...newOnes];
}

/**
 * The ordered, enabled-only subset {@link AdjustShippingMethod} steps through. Falls back to the
 * full live profile order (all enabled) when nothing has been configured yet, so +/- works before
 * the user ever opens the config UI.
 */
export async function getEnabledShippingOrder(liveNames: string[]): Promise<string[]> {
	const saved = await getShippingOrder();
	if (saved.length === 0) return liveNames;
	return mergeWithLiveProfiles(saved, liveNames)
		.filter((entry) => entry.enabled)
		.map((entry) => entry.name);
}
