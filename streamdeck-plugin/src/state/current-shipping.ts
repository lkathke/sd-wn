import streamDeck from "@elgato/streamdeck";

export type ShippingTarget = "auction" | "giveaway";

// Auction and giveaway listings each carry their own, independent shippingProfile (confirmed live
// — a giveaway listing had a real "Bis 50g" profile of its own) — tracked separately here so
// stepping/resetting one target's Current Shipping Display / Adjust Shipping Method key never
// clobbers the other's. Keyed global settings rather than two flat fields, so this scales the same
// way if a third listing type ever needs its own shipping tracking.
type GlobalSettings = { currentShippingLabels?: Partial<Record<ShippingTarget, string>> };
type Listener = (target: ShippingTarget, label: string) => void;

const listeners = new Set<Listener>();

/**
 * The "current" shipping method label for the given target (auction/giveaway), shared across
 * shipping-related keys configured for that same target — lets a display key show what's
 * currently selected regardless of which key set it last.
 */
export async function getCurrentShippingLabel(target: ShippingTarget): Promise<string> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	return settings.currentShippingLabels?.[target] ?? "";
}

export async function setCurrentShippingLabel(target: ShippingTarget, label: string): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	const changed = (settings.currentShippingLabels?.[target] ?? "") !== label;
	const currentShippingLabels = { ...settings.currentShippingLabels, [target]: label };
	await streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...settings, currentShippingLabels });
	// Only notify (and thus flash Current Shipping Display) if this target's label actually
	// changed — the overlay's overlayState report resends price/shipping/mode together whenever
	// ANY of them changes, so without this guard e.g. editing the price used to flash the shipping
	// tile too, since this setter always fired regardless of whether the label itself moved.
	if (changed) {
		for (const listener of listeners) listener(target, label);
	}
}

/** Subscribes to changes of either target's current shipping label, e.g. for a display key that flashes on update. */
export function onShippingChange(listener: Listener): void {
	listeners.add(listener);
}
