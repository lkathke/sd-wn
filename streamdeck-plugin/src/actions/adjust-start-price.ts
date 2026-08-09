import {
	action,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	KeyUpEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKey } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { adjustCurrentPriceCents } from "../state/current-price";

const POSITIVE_BG = "#1e8e3e";
const NEGATIVE_BG = "#c0392b";
const NEUTRAL_BG = "#3a3f47";
const TEXT_COLOR = "#ffffff";

// How long a key must be held before it switches to the bigger "hold" step, and how often that
// bigger step then repeats while still held.
const HOLD_THRESHOLD_MS = 500;
const REPEAT_INTERVAL_MS = 500;

type SlotAction = KeyAction<AdjustPriceSettings>;

const visible = new Map<string, { action: SlotAction; settings: AdjustPriceSettings }>();

// Per-key-instance hold tracking. A key is only ever pressed by one finger at a time, so a single
// timeout/interval pair per action id is enough — no need to key this by device/press id.
type HoldTracking = {
	holdTimeout?: ReturnType<typeof setTimeout>;
	repeatInterval?: ReturnType<typeof setInterval>;
	held: boolean;
};
const holdTracking = new Map<string, HoldTracking>();

/** Parses `delta`, defaulting to 1; parses `holdDelta`, defaulting to 5x the small step. */
function parseDeltas(settings: AdjustPriceSettings): { delta: number; holdDelta: number } {
	const rawDelta = parseFloat(settings.delta ?? "1");
	const delta = Number.isNaN(rawDelta) ? 1 : rawDelta;
	const sign = delta >= 0 ? 1 : -1;

	const rawHold = parseFloat(settings.holdDelta ?? "");
	const holdMagnitude = Number.isNaN(rawHold) ? Math.abs(delta) * 5 : Math.abs(rawHold);

	return { delta, holdDelta: sign * holdMagnitude };
}

function formatLabel(settings: AdjustPriceSettings, activeDelta: number): { text: string; bgColor: string } {
	const symbol = settings.currencySymbol ?? "€";
	const text = activeDelta >= 0 ? `+${activeDelta}${symbol}` : `${activeDelta}${symbol}`;
	const prefixed = isExtensionConnected() ? text : `⚠ ${text}`;
	return { text: prefixed, bgColor: activeDelta >= 0 ? POSITIVE_BG : NEGATIVE_BG };
}

async function render(slotAction: SlotAction, settings: AdjustPriceSettings, activeDelta?: number): Promise<void> {
	const { delta } = parseDeltas(settings);
	const { text, bgColor } = formatLabel(settings, activeDelta ?? delta);
	await renderStaticKey(slotAction, text, { bgColor, textColor: TEXT_COLOR, fontSize: 32 });
}

async function applyDelta(euros: number, currencySymbol: string): Promise<number> {
	const clampedCents = await adjustCurrentPriceCents(Math.round(euros * 100));
	return broadcastCommand({ type: "setStartPrice", price: (clampedCents / 100).toFixed(2), currencySymbol });
}

onConnectionStatusChange(() => {
	for (const { action: slotAction, settings } of visible.values()) void render(slotAction, settings);
});

/**
 * Adjusts the shared "current price" (see src/state/current-price.ts) up or down by a configurable
 * amount and re-broadcasts it, so multiple keys with different deltas (+1, +5, -1, ...) can all
 * nudge the same running total instead of each preset key being an island. Rendered as a solid
 * green (positive delta) or red (negative delta) tile instead of the default placeholder icon, so
 * the sign is readable at a glance.
 *
 * Holding the key past {@link HOLD_THRESHOLD_MS} switches to a bigger configurable step
 * (`holdDelta`), shown on the tile in place of the normal step, and repeats it every
 * {@link REPEAT_INTERVAL_MS} for as long as the key stays held — a quick tap still only applies
 * the small step once.
 */
@action({ UUID: "com.lkathke.whatnot-controller.adjust-start-price" })
export class AdjustStartPrice extends SingletonAction<AdjustPriceSettings> {
	override async onWillAppear(ev: WillAppearEvent<AdjustPriceSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<AdjustPriceSettings>): void {
		visible.delete(ev.action.id);
		this.clearHold(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AdjustPriceSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override onKeyDown(ev: KeyDownEvent<AdjustPriceSettings>): void {
		const { delta, holdDelta } = parseDeltas(ev.payload.settings);
		if (delta === 0) {
			void ev.action.showAlert();
			return;
		}

		const currencySymbol = ev.payload.settings.currencySymbol ?? "€";
		const tracking: HoldTracking = { held: false };
		holdTracking.set(ev.action.id, tracking);

		// Deliberately deferred: we don't know yet whether this is a tap or a hold. If the hold
		// threshold fires first, we switch modes entirely instead of also having applied the small
		// step — see the class doc comment.
		tracking.holdTimeout = setTimeout(() => {
			tracking.held = true;
			void render(ev.action, ev.payload.settings, holdDelta);
			void applyDelta(holdDelta, currencySymbol);
			tracking.repeatInterval = setInterval(() => {
				void applyDelta(holdDelta, currencySymbol);
			}, REPEAT_INTERVAL_MS);
		}, HOLD_THRESHOLD_MS);
	}

	override async onKeyUp(ev: KeyUpEvent<AdjustPriceSettings>): Promise<void> {
		const tracking = holdTracking.get(ev.action.id);
		this.clearHold(ev.action.id);
		if (!tracking) return;

		if (tracking.held) {
			// Was a hold: the repeat loop already applied every step; nothing left to do except
			// restore the tile to its normal (small-step) display.
			await render(ev.action, ev.payload.settings);
			return;
		}

		const { delta } = parseDeltas(ev.payload.settings);
		const currencySymbol = ev.payload.settings.currencySymbol ?? "€";
		const sentTo = await applyDelta(delta, currencySymbol);

		// No checkmark here on purpose — the paired Current Price Display key flashes red instead,
		// so the feedback lands on the value that changed rather than the button that was pressed.
		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}

	private clearHold(actionId: string): void {
		const tracking = holdTracking.get(actionId);
		if (!tracking) return;
		if (tracking.holdTimeout) clearTimeout(tracking.holdTimeout);
		if (tracking.repeatInterval) clearInterval(tracking.repeatInterval);
		holdTracking.delete(actionId);
	}
}

/**
 * Settings for {@link AdjustStartPrice}. `delta`/`holdDelta` are strings (not numbers) because they
 * come straight from sdpi-components text fields; negative values (e.g. "-1") decrease the price.
 * `holdDelta`'s sign always follows `delta`'s — only its magnitude is configurable.
 */
type AdjustPriceSettings = {
	delta?: string;
	holdDelta?: string;
	currencySymbol?: string;
};
