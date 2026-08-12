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
import { renderStaticKeyWrapped } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { ensureCustomShippingProfilesLoaded, getCustomShippingProfileAtSlot } from "../state/custom-shipping-grid";
import { setCurrentShippingLabel } from "../state/current-shipping";

// Same look as Set Shipping Method's default (self-drawn tile, no placeholder icon/native title)
// instead of this action's original plain setTitle() rendering, which left Elgato's default
// blue-icon placeholder showing behind the text.
const BG_COLOR = "#2d3138";
const TEXT_COLOR = "#ffffff";
// A slot past the end of the sorted custom-profile list (e.g. the seller has fewer than ~14
// custom profiles) renders fully black instead of the normal tile — a clear "unused" look rather
// than an empty-looking dark-grey tile with just a "—".
const EMPTY_BG_COLOR = "#000000";

type SlotAction = KeyAction<CustomShippingWeightSlotSettings>;

const visibleSlots = new Map<string, { action: SlotAction; slotIndex: number }>();

onConnectionStatusChange(() => {
	for (const { action: slotAction, slotIndex } of visibleSlots.values()) void renderSlot(slotAction, slotIndex);
});

async function renderSlot(slotAction: SlotAction, slotIndex: number): Promise<void> {
	const profile = getCustomShippingProfileAtSlot(slotIndex);
	if (!profile) {
		await renderStaticKeyWrapped(slotAction, "", { bgColor: EMPTY_BG_COLOR, textColor: TEXT_COLOR, fontSize: 20 });
		return;
	}
	const prefixed = isExtensionConnected() ? profile.name : `⚠ ${profile.name}`;
	await renderStaticKeyWrapped(slotAction, prefixed, { bgColor: BG_COLOR, textColor: TEXT_COLOR, fontSize: 20 });
}

/**
 * One tile of a ~14-key grid meant to be placed directly in a Stream Deck Folder (no nav keys —
 * unlike {@link ShippingPickerSlot}, this shows every one of the seller's *own* custom shipping
 * profiles that fits, sorted lightest-first, so "slot" here is just this key's position in that
 * fixed, sorted list rather than an offset into a paginated cache). Same effect as Set Shipping
 * Method when pressed — sets the shared current shipping label for the configured target
 * (auction/giveaway) and broadcasts it to the overlay.
 */
@action({ UUID: "com.lkathke.whatnot-controller.custom-shipping-weight-slot" })
export class CustomShippingWeightSlot extends SingletonAction<CustomShippingWeightSlotSettings> {
	override async onWillAppear(ev: WillAppearEvent<CustomShippingWeightSlotSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		visibleSlots.set(ev.action.id, { action: ev.action, slotIndex });

		await ensureCustomShippingProfilesLoaded();
		await renderSlot(ev.action, slotIndex);
	}

	override onWillDisappear(ev: WillDisappearEvent<CustomShippingWeightSlotSettings>): void {
		visibleSlots.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CustomShippingWeightSlotSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		visibleSlots.set(ev.action.id, { action: ev.action, slotIndex });
		await renderSlot(ev.action, slotIndex);
	}

	override async onKeyDown(ev: KeyDownEvent<CustomShippingWeightSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		const profile = getCustomShippingProfileAtSlot(slotIndex);

		if (!profile) {
			await ev.action.showAlert();
			return;
		}

		const target = ev.payload.settings.target ?? "auction";
		await setCurrentShippingLabel(target, profile.name);
		const sentTo = broadcastCommand({ type: "setShippingMethod", label: profile.name, target });

		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link CustomShippingWeightSlot}. `slot` is a string (sdpi text field) holding a
 * 0-based index into the sorted custom-profile list; `target` picks which listing type's shipping
 * tracker (see state/current-shipping.ts) this key sets — "auction" if unset.
 */
type CustomShippingWeightSlotSettings = {
	slot?: string;
	target?: "auction" | "giveaway";
};
