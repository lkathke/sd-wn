import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKeyLines } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { AuctionMode, getCurrentAuctionMode, onAuctionModeChange, setCurrentAuctionMode } from "../state/auction-mode";

const OFF_BG = "#2d3138";
const ON_BG = "#e5484d";
const TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<Record<string, never>>;

const visible = new Map<string, SlotAction>();

// Fixed line breaks ("Sudden" / "Death" / state word / optional "❗") instead of word-wrapping —
// the icon needs to be pinned to its own trailing line, not just appended to the text and hoped
// it wraps there on its own.
async function render(slotAction: SlotAction, mode: AuctionMode): Promise<void> {
	const on = mode === "suddenDeath";
	const state = on ? "aktiviert" : "deaktiviert";
	const lines: (string | { text: string; fontSize?: number; gapBefore?: number })[] = [
		"Sudden",
		"Death",
		isExtensionConnected() ? state : `⚠ ${state}`
	];
	// Plain "!" instead of the ❗ emoji — emoji glyphs render with their own built-in colors (a
	// white square with a red mark) and ignore our `fill`, so on the red ON_BG it just disappeared.
	// Extra gapBefore so the bigger glyph reads as a separate icon, not a cramped 4th text line.
	if (on) lines.push({ text: "!", fontSize: 30, gapBefore: 10 });
	await renderStaticKeyLines(slotAction, lines, {
		bgColor: on ? ON_BG : OFF_BG,
		textColor: TEXT_COLOR,
		fontSize: 18
	});
}

onConnectionStatusChange(async () => {
	const mode = await getCurrentAuctionMode();
	for (const slotAction of visible.values()) void render(slotAction, mode);
});

onAuctionModeChange((mode) => {
	for (const slotAction of visible.values()) void render(slotAction, mode);
});

/**
 * Flips the shared auction mode between "standard" and "suddenDeath" (see
 * state/auction-mode.ts) and broadcasts it to the overlay's mode select, which is what
 * `startAuctionFromCurrentState()` actually reads when the auction starts. The key itself doubles
 * as the display of the current mode (red when Sudden Death is armed) since there's no separate
 * "current mode" display key — unlike price/shipping, there's only one other consumer of this
 * value (Start Auction), so a dedicated display tile would be redundant.
 */
@action({ UUID: "com.lkathke.whatnot-controller.toggle-sudden-death" })
export class ToggleSuddenDeath extends SingletonAction<Record<string, never>> {
	override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, ev.action);
		await render(ev.action, await getCurrentAuctionMode());
	}

	override onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): void {
		visible.delete(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<Record<string, never>>): Promise<void> {
		const next: AuctionMode = (await getCurrentAuctionMode()) === "suddenDeath" ? "standard" : "suddenDeath";
		await setCurrentAuctionMode(next);
		const sentTo = broadcastCommand({ type: "setAuctionMode", mode: next });
		if (sentTo === 0) await ev.action.showAlert();
	}
}
