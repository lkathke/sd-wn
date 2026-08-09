import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKeyTwoLine } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";

const BG_COLOR = "#2d3138";
const TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<Record<string, never>>;

const visible = new Map<string, SlotAction>();

async function render(slotAction: SlotAction): Promise<void> {
	const bottomText = isExtensionConnected() ? "Anpinnen" : "⚠ Anpinnen";
	await renderStaticKeyTwoLine(slotAction, "📌", bottomText, {
		bgColor: BG_COLOR,
		textColor: TEXT_COLOR,
		topFontSize: 52,
		bottomFontSize: 24
	});
}

onConnectionStatusChange(() => {
	for (const slotAction of visible.values()) void render(slotAction);
});

/**
 * Pins whatever listing is currently selected in the browser overlay — same `pin_product` push the
 * browser's own pin action uses. Pinning shows the listing's price/shipping/image as the live
 * "featured" preview buyers see, independent of whether an auction has actually started.
 */
@action({ UUID: "com.lkathke.whatnot-controller.pin-listing" })
export class PinListingButton extends SingletonAction<Record<string, never>> {
	override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Record<string, never>>): Promise<void> {
		const sentTo = broadcastCommand({ type: "pinListing" });
		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}
