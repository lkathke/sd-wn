import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKeyTwoLine } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";

const BG_COLOR = "#2d3138";
const TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<Record<string, never>>;

const visible = new Map<string, SlotAction>();

async function render(slotAction: SlotAction): Promise<void> {
	const bottomText = isExtensionConnected() ? "Gewinner" : "⚠ Gewinner";
	await renderStaticKeyTwoLine(slotAction, "🏆", bottomText, {
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
 * Draws a winner for the currently running giveaway (or ends it early with no entries) — same
 * `select_giveaway_winner` push the browser's "Draw Winner"/"End Giveaway" button uses; the
 * overlay only enables this once it has seen a `giveaway_started` event for the selected listing
 * (see whatnot-helper/src/overlay.js), so pressing this before a giveaway is live is a no-op error
 * on the extension side, not a crash.
 */
@action({ UUID: "com.lkathke.whatnot-controller.draw-giveaway-winner" })
export class DrawGiveawayWinnerButton extends SingletonAction<Record<string, never>> {
	override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Record<string, never>>): Promise<void> {
		const sentTo = broadcastCommand({ type: "drawGiveawayWinner" });
		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}
