import {
	action,
	DialAction,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";

import { onConnectionStatusChange, withConnectionIndicator } from "../bridge/connection-status";
import { broadcastCommand } from "../bridge/ws-server";
import { setCurrentShippingLabel } from "../state/current-shipping";
import { ensureShippingProfilesLoaded, getShippingProfileAtSlot } from "../state/shipping-picker";

type SlotAction = KeyAction<ShippingSlotSettings> | DialAction<ShippingSlotSettings>;

const visibleSlots = new Map<string, { action: SlotAction; slotIndex: number }>();

onConnectionStatusChange(() => {
	void refreshVisibleShippingSlots();
});

/**
 * Re-renders every currently visible shipping-picker slot key from the cached profile list and
 * current page. Called after a page-navigation key press, and after (re)loading the profile list.
 */
export async function refreshVisibleShippingSlots(): Promise<void> {
	for (const { action: slotAction, slotIndex } of visibleSlots.values()) {
		await renderSlot(slotAction, slotIndex);
	}
}

async function renderSlot(slotAction: SlotAction, slotIndex: number): Promise<void> {
	const profile = getShippingProfileAtSlot(slotIndex);
	await slotAction.setTitle(withConnectionIndicator(profile ? profile.name : "—"));
}

/**
 * One tile of a multi-key "page" of shipping profiles. Place several of these on a Stream Deck
 * page, each with a distinct "Slot" index (0-based), plus a {@link ShippingPickerNav} key or two
 * to page through the seller's full shipping-profile list. See src/state/shipping-picker.ts for
 * the shared cache/pagination state.
 */
@action({ UUID: "com.lkathke.whatnot-controller.shipping-picker-slot" })
export class ShippingPickerSlot extends SingletonAction<ShippingSlotSettings> {
	override async onWillAppear(ev: WillAppearEvent<ShippingSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		visibleSlots.set(ev.action.id, { action: ev.action, slotIndex });

		await ensureShippingProfilesLoaded();
		await renderSlot(ev.action, slotIndex);
	}

	override onWillDisappear(ev: WillDisappearEvent<ShippingSlotSettings>): void {
		visibleSlots.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ShippingSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		visibleSlots.set(ev.action.id, { action: ev.action, slotIndex });
		await renderSlot(ev.action, slotIndex);
	}

	override async onKeyDown(ev: KeyDownEvent<ShippingSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		const profile = getShippingProfileAtSlot(slotIndex);

		if (!profile) {
			await ev.action.showAlert();
			return;
		}

		// Hardcoded to "auction" — the grid picker has no target checkbox (only Current Shipping
		// Display/Adjust Shipping Method got one).
		await setCurrentShippingLabel("auction", profile.name);
		const sentTo = broadcastCommand({ type: "setShippingMethod", label: profile.name, target: "auction" });

		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link ShippingPickerSlot}. `slot` is a string (sdpi text field) holding a 0-based
 * index into the current page of the shared shipping-profile cache.
 */
type ShippingSlotSettings = {
	slot?: string;
};
