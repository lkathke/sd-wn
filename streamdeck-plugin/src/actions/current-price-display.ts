import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderDisplayText } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { getCurrentPriceCents, onPriceChange, setCurrentPriceCents } from "../state/current-price";

type DisplayAction = KeyAction<CurrentPriceDisplaySettings>;

const visible = new Map<string, DisplayAction>();

/** Whole-euro amounts drop the ",00" and render larger — easier to read at a glance mid-show. */
function formatPrice(cents: number): { text: string; fontSize: number } {
	const euros = cents / 100;
	const isWhole = Number.isInteger(euros);
	const text = `${isWhole ? euros : euros.toFixed(2)}€`;
	return { text: isExtensionConnected() ? text : `⚠ ${text}`, fontSize: isWhole ? 42 : 32 };
}

async function render(displayAction: DisplayAction, changed: boolean): Promise<void> {
	const cents = await getCurrentPriceCents();
	const { text, fontSize } = formatPrice(cents);
	await renderDisplayText(displayAction, text, fontSize, changed);
}

onPriceChange(() => {
	for (const displayAction of visible.values()) void render(displayAction, true);
});
onConnectionStatusChange(() => {
	for (const displayAction of visible.values()) void render(displayAction, false);
});

/**
 * Read-only tile showing the shared "current start price" (see src/state/current-price.ts) as a
 * self-drawn image (not the native title overlay, which can't be recolored per-call), flashing the
 * text red briefly whenever it changes. Doesn't open a menu on press (Stream Deck plugins can't
 * programmatically open a user's folder); place a native Stream Deck Folder key next to this one,
 * containing the price-preset keys, instead. Pressing this tile resets the price back to a
 * configurable default (see the "Default Price" property inspector field) — a quick "start over"
 * for the next item.
 */
@action({ UUID: "com.lkathke.whatnot-controller.current-price-display" })
export class CurrentPriceDisplay extends SingletonAction<CurrentPriceDisplaySettings> {
	override async onWillAppear(ev: WillAppearEvent<CurrentPriceDisplaySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action, false);
	}

	override onWillDisappear(ev: WillDisappearEvent<CurrentPriceDisplaySettings>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<CurrentPriceDisplaySettings>): Promise<void> {
		const defaultPrice = parseFloat(ev.payload.settings.defaultPrice ?? "1");
		const requestedCents = Math.round((Number.isNaN(defaultPrice) ? 1 : defaultPrice) * 100);

		const clampedCents = await setCurrentPriceCents(requestedCents);
		const sentTo = broadcastCommand({
			type: "setStartPrice",
			price: (clampedCents / 100).toFixed(2),
			currencySymbol: "€"
		});

		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link CurrentPriceDisplay}. `defaultPrice` (in €, e.g. "1") is what pressing the
 * tile resets the shared current price to.
 */
type CurrentPriceDisplaySettings = {
	defaultPrice?: string;
};
