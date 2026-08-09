import streamDeck from "@elgato/streamdeck";

export type AuctionMode = "standard" | "suddenDeath";

type GlobalSettings = { currentAuctionMode?: AuctionMode };
type Listener = (mode: AuctionMode) => void;

const listeners = new Set<Listener>();

/**
 * The auction mode (standard vs. sudden death) isn't stored on the listing — it's a boolean the
 * app sends fresh with every `start_auction` push (see whatnot-helper/src/bridge.js's
 * `startAuction`). We still track a "current" value in global settings, mirroring the price/
 * shipping pattern, so a single toggle key can reflect and flip it before the next start.
 */
export async function getCurrentAuctionMode(): Promise<AuctionMode> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	return settings.currentAuctionMode ?? "standard";
}

export async function setCurrentAuctionMode(mode: AuctionMode): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	const changed = (settings.currentAuctionMode ?? "standard") !== mode;
	await streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...settings, currentAuctionMode: mode });
	if (changed) {
		for (const listener of listeners) listener(mode);
	}
}

/** Subscribes to changes of the current auction mode, e.g. for the toggle key's own rendering. */
export function onAuctionModeChange(listener: Listener): void {
	listeners.add(listener);
}
