import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKeyTwoLine } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";

const BG_COLOR = "#ff5a1f";
const TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<Record<string, never>>;

const visible = new Map<string, SlotAction>();

async function render(slotAction: SlotAction): Promise<void> {
	const bottomText = isExtensionConnected() ? "Start" : "⚠ Start";
	await renderStaticKeyTwoLine(slotAction, "🎁", bottomText, {
		bgColor: BG_COLOR,
		textColor: TEXT_COLOR,
		topFontSize: 52,
		bottomFontSize: 26
	});
}

onConnectionStatusChange(() => {
	for (const slotAction of visible.values()) void render(slotAction);
});

/**
 * Starts the giveaway for whatever listing the overlay currently has selected — the listing must
 * already be configured as a giveaway (transactionType GIVEAWAY) via the browser, since the socket
 * push only carries the product UUID, no config (see whatnot-helper's configureGiveaway doc
 * comment). Mirrors StartAuctionButton's single-press, no-confirm design for the same reason: a
 * dedicated physical key doesn't need the browser button's two-step confirm.
 */
@action({ UUID: "com.lkathke.whatnot-controller.start-giveaway" })
export class StartGiveawayButton extends SingletonAction<Record<string, never>> {
	override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Record<string, never>>): Promise<void> {
		const sentTo = broadcastCommand({ type: "startGiveaway" });
		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}
