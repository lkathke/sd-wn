import {
	action,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKey } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { setCurrentPriceCents } from "../state/current-price";

const DEFAULT_BG = "#2d3138";
const DEFAULT_TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<StartPriceSettings>;

const visible = new Map<string, { action: SlotAction; settings: StartPriceSettings }>();

/** Whole-euro amounts drop the ",00" and render larger — easier to read at a glance mid-show. */
function formatLabel(
	settings: StartPriceSettings
): { text: string; fontSize: number; bgColor: string; textColor: string } {
	const bgColor = settings.bgColor || DEFAULT_BG;
	const textColor = settings.textColor || DEFAULT_TEXT_COLOR;
	if (!settings.price) return { text: "Startpreis", fontSize: 20, bgColor, textColor };

	const symbol = settings.currencySymbol ?? "€";
	const amount = parseFloat(settings.price);
	const isWhole = !Number.isNaN(amount) && Number.isInteger(amount);
	const text = Number.isNaN(amount) ? settings.price : `${isWhole ? amount : amount.toFixed(2)}${symbol}`;
	const prefixed = isExtensionConnected() ? text : `⚠ ${text}`;

	return { text: prefixed, fontSize: isWhole ? 34 : 26, bgColor, textColor };
}

async function render(slotAction: SlotAction, settings: StartPriceSettings): Promise<void> {
	const { text, fontSize, bgColor, textColor } = formatLabel(settings);
	await renderStaticKey(slotAction, text, { bgColor, textColor, fontSize });
}

onConnectionStatusChange(() => {
	for (const { action: slotAction, settings } of visible.values()) void render(slotAction, settings);
});

/**
 * Sends a preset start price to the active Whatnot auction via the local WebSocket bridge.
 * Rendered as a solid-color tile (configurable per key) with the price as large text, instead of
 * the default placeholder icon.
 */
@action({ UUID: "com.lkathke.whatnot-controller.set-start-price" })
export class SetStartPrice extends SingletonAction<StartPriceSettings> {
	override async onWillAppear(ev: WillAppearEvent<StartPriceSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<StartPriceSettings>): void {
		visible.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<StartPriceSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<StartPriceSettings>): Promise<void> {
		const { price, currencySymbol } = ev.payload.settings;

		if (!price) {
			await ev.action.showAlert();
			return;
		}

		const clampedCents = await setCurrentPriceCents(Math.round(parseFloat(price) * 100));

		const sentTo = broadcastCommand({
			type: "setStartPrice",
			price: (clampedCents / 100).toFixed(2),
			currencySymbol: currencySymbol ?? "€"
		});

		// No checkmark here on purpose — the paired Current Price Display key flashes red instead.
		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link SetStartPrice}. `bgColor`/`textColor` are hex strings from sdpi-color fields.
 */
type StartPriceSettings = {
	price?: string;
	currencySymbol?: string;
	bgColor?: string;
	textColor?: string;
};
