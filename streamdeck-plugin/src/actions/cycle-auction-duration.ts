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
import { renderStaticKeyTwoLine } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";

const BG_COLOR = "#6b4fa0";
const TEXT_COLOR = "#ffffff";
const DEFAULT_DURATIONS = "15,30,45,60";

type SlotAction = KeyAction<CycleDurationSettings>;

const visible = new Map<string, { action: SlotAction; settings: CycleDurationSettings }>();

function parseDurations(raw?: string): number[] {
	const list = (raw ?? DEFAULT_DURATIONS)
		.split(",")
		.map((s) => parseInt(s.trim(), 10))
		.filter((n) => Number.isFinite(n) && n > 0);
	return list.length > 0 ? list : [30];
}

function currentSeconds(settings: CycleDurationSettings): number {
	const durations = parseDurations(settings.durations);
	const index = Math.min(Math.max(settings.currentIndex ?? 0, 0), durations.length - 1);
	return durations[index];
}

async function render(slotAction: SlotAction, settings: CycleDurationSettings): Promise<void> {
	const text = `${currentSeconds(settings)}s`;
	const prefixed = isExtensionConnected() ? text : `⚠ ${text}`;
	await renderStaticKeyTwoLine(slotAction, prefixed, "Dauer", {
		bgColor: BG_COLOR,
		textColor: TEXT_COLOR,
		topFontSize: 44,
		bottomFontSize: 16
	});
}

onConnectionStatusChange(() => {
	for (const { action: slotAction, settings } of visible.values()) void render(slotAction, settings);
});

/**
 * A single key that cycles through a configurable list of auction durations on each press
 * (e.g. 15s → 30s → 45s → 60s → back to 15s), instead of needing one preset key per duration.
 * The current position is persisted in the key's own settings, not shared/global state — each
 * instance of this action cycles independently.
 */
@action({ UUID: "com.lkathke.whatnot-controller.cycle-auction-duration" })
export class CycleAuctionDuration extends SingletonAction<CycleDurationSettings> {
	override async onWillAppear(ev: WillAppearEvent<CycleDurationSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<CycleDurationSettings>): void {
		visible.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CycleDurationSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<CycleDurationSettings>): Promise<void> {
		const durations = parseDurations(ev.payload.settings.durations);
		const nextIndex = ((ev.payload.settings.currentIndex ?? 0) + 1) % durations.length;
		const newSettings: CycleDurationSettings = { ...ev.payload.settings, currentIndex: nextIndex };

		await ev.action.setSettings(newSettings);
		visible.set(ev.action.id, { action: ev.action, settings: newSettings });
		await render(ev.action, newSettings);

		const sentTo = broadcastCommand({ type: "setAuctionDuration", seconds: durations[nextIndex] });
		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link CycleAuctionDuration}. `durations` is a comma-separated list of seconds
 * (sdpi text field, e.g. "15,30,45,60"); `currentIndex` is maintained by the action itself.
 */
type CycleDurationSettings = {
	durations?: string;
	currentIndex?: number;
};
