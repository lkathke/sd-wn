import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKeyTwoLine } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";

// Muted grey (vs. Pin Listing's default dark background) plus a distinct "prohibited" glyph
// instead of the pin itself — the strikethrough-pin look tried earlier read as visually odd
// (looked like broken/glitched text rather than a clear "opposite action" icon).
const BG_COLOR = "#4a4f57";
const TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<Record<string, never>>;

const visible = new Map<string, SlotAction>();

async function render(slotAction: SlotAction): Promise<void> {
	const bottomText = isExtensionConnected() ? "Abpinnen" : "⚠ Abpinnen";
	await renderStaticKeyTwoLine(slotAction, "🚫", bottomText, {
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
 * Unpins whatever listing is currently selected in the browser overlay — same `unpin_product` push
 * the browser's own unpin action uses.
 */
@action({ UUID: "com.lkathke.whatnot-controller.unpin-listing" })
export class UnpinListingButton extends SingletonAction<Record<string, never>> {
	override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Record<string, never>>): Promise<void> {
		const sentTo = broadcastCommand({ type: "unpinListing" });
		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}
