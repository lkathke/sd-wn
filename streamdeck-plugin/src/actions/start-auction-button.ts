import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKeyTwoLine } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";

const BG_COLOR = "#ff5a1f";
const TEXT_COLOR = "#ffffff";
const DEFAULT_BUMP_SECONDS = 5;

type SlotAction = KeyAction<StartAuctionSettings>;

const visible = new Map<string, SlotAction>();

async function render(slotAction: SlotAction): Promise<void> {
	const bottomText = isExtensionConnected() ? "Start" : "⚠ Start";
	await renderStaticKeyTwoLine(slotAction, "🔨", bottomText, {
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
 * Starts the currently configured auction in the overlay (whatever listing/price/shipping/duration
 * is set there) via the "startAuction" bridge command. Unlike the browser's own "Auktion starten"
 * button, this is a single press without a two-step confirm — see
 * whatnot-helper/src/overlay.js's startAuctionFromCurrentState() comment for why that's an
 * intentional trade-off for a dedicated physical key. Also carries this key's own configured bump
 * time (default 5s) — the overlay applies it to the bar's Bump field right before starting, same
 * nearest-preset fallback as Cycle Auction Duration, so this key's press always uses a known bump
 * value instead of whatever the bar happened to have left over from a previous listing.
 */
@action({ UUID: "com.lkathke.whatnot-controller.start-auction" })
export class StartAuctionButton extends SingletonAction<StartAuctionSettings> {
	override async onWillAppear(ev: WillAppearEvent<StartAuctionSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<StartAuctionSettings>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<StartAuctionSettings>): Promise<void> {
		const bumpSeconds = parseInt(ev.payload.settings.bumpSeconds ?? "", 10);
		const sentTo = broadcastCommand({
			type: "startAuction",
			bumpSeconds: Number.isFinite(bumpSeconds) ? bumpSeconds : DEFAULT_BUMP_SECONDS
		});
		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link StartAuctionButton}. `bumpSeconds` is a string (sdpi text field); defaults
 * to {@link DEFAULT_BUMP_SECONDS} when empty/unset.
 */
type StartAuctionSettings = {
	bumpSeconds?: string;
};
