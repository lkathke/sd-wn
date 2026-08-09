import streamDeck from "@elgato/streamdeck";

type GlobalSettings = { currentPriceCents?: number };
type Listener = (cents: number) => void;

const listeners = new Set<Listener>();

// Whatnot doesn't allow a 0€ start price — enforced here, once, so every path that can change the
// price (presets, +/-, the display tile's reset-to-default) is covered automatically instead of
// each caller having to remember to validate.
const MIN_PRICE_CENTS = 100;

/**
 * The "current" auction start price, shared across all price-related keys (presets and +/-
 * adjusters) via Stream Deck's global settings. Presets overwrite it outright; +/- keys adjust
 * relative to it, so pressing "10€" then "+1" ends up at 11€ regardless of which key was pressed
 * last.
 */
export async function getCurrentPriceCents(): Promise<number> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	return settings.currentPriceCents ?? MIN_PRICE_CENTS;
}

/**
 * Sets the current price, clamped to a minimum of 1€, and returns the actual (clamped) value —
 * callers should broadcast *this* value, not whatever was requested, so the overlay never shows a
 * price that got silently rejected.
 */
export async function setCurrentPriceCents(cents: number): Promise<number> {
	const clamped = Math.max(MIN_PRICE_CENTS, Math.round(cents));
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	const changed = (settings.currentPriceCents ?? MIN_PRICE_CENTS) !== clamped;
	await streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...settings, currentPriceCents: clamped });
	// Only notify (and thus flash Current Price Display) if the value actually changed — the
	// overlay's overlayState report resends the whole snapshot whenever ANY of price/shipping/mode
	// changes, so without this guard, e.g. toggling Sudden Death (mode only) used to flash the price
	// tile too, since this setter always fired regardless of whether cents itself moved.
	if (changed) {
		for (const listener of listeners) listener(clamped);
	}
	return clamped;
}

/** Subscribes to changes of the current price, e.g. for a display key that flashes on update. */
export function onPriceChange(listener: Listener): void {
	listeners.add(listener);
}

// Serializes adjustCurrentPriceCents calls (see below) so rapid presses can't race each other.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Atomically reads the current price, adds `deltaCents`, clamps, and writes it back — as a single
 * queued step rather than a separate get+set pair. Confirmed live: Adjust Start Price's own
 * get-then-set (read current, compute, write) lost decrements under rapid repeated presses (e.g.
 * several quick "-1€" taps), because each press's read could complete before an earlier press's
 * write had landed, so both computed from the same stale value and the second write clobbered the
 * first instead of compounding. Queuing every adjustment through this one function serializes them
 * so each read always sees the previous adjustment's result.
 */
export function adjustCurrentPriceCents(deltaCents: number): Promise<number> {
	const result = queue.then(async () => {
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		const current = settings.currentPriceCents ?? MIN_PRICE_CENTS;
		const clamped = Math.max(MIN_PRICE_CENTS, Math.round(current + deltaCents));
		const changed = current !== clamped;
		await streamDeck.settings.setGlobalSettings<GlobalSettings>({ ...settings, currentPriceCents: clamped });
		if (changed) {
			for (const listener of listeners) listener(clamped);
		}
		return clamped;
	});
	// Keep the chain alive even if a step throws, so one failed adjustment doesn't permanently wedge
	// every adjustment after it.
	queue = result.catch(() => undefined);
	return result;
}
