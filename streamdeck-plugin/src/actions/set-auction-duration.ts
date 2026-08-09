import {
	action,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";

import { trackTitle } from "../bridge/visible-title-tracker";
import { broadcastCommand } from "../bridge/ws-server";

const titleTracker = trackTitle<AuctionDurationSettings>(formatTitle);

/**
 * Sends a preset auction duration (in seconds) to the active Whatnot auction via the local
 * WebSocket bridge.
 */
@action({ UUID: "com.lkathke.whatnot-controller.set-auction-duration" })
export class SetAuctionDuration extends SingletonAction<AuctionDurationSettings> {
	override onWillAppear(ev: WillAppearEvent<AuctionDurationSettings>): void | Promise<void> {
		return titleTracker.show(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<AuctionDurationSettings>): void {
		titleTracker.hide(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<AuctionDurationSettings>): void | Promise<void> {
		return titleTracker.update(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<AuctionDurationSettings>): Promise<void> {
		const seconds = parseInt(ev.payload.settings.seconds ?? "", 10);

		if (!seconds || Number.isNaN(seconds) || seconds <= 0) {
			await ev.action.showAlert();
			return;
		}

		const sentTo = broadcastCommand({ type: "setAuctionDuration", seconds });

		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}

function formatTitle(settings: AuctionDurationSettings): string {
	return settings.seconds ? `${settings.seconds}s` : "Set Duration";
}

/**
 * Settings for {@link SetAuctionDuration}.
 */
type AuctionDurationSettings = {
	seconds?: string;
};
