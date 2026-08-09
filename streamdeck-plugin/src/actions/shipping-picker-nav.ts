import { action, KeyDownEvent, SingletonAction } from "@elgato/streamdeck";

import { refreshVisibleShippingSlots } from "./shipping-picker-slot";
import {
	ensureShippingProfilesLoaded,
	getShippingMaxPage,
	getShippingPage,
	setShippingPage
} from "../state/shipping-picker";

/**
 * Pages the shared shipping-profile picker forward or backward, then refreshes every currently
 * visible {@link ShippingPickerSlot} key to reflect the new page.
 */
@action({ UUID: "com.lkathke.whatnot-controller.shipping-picker-nav" })
export class ShippingPickerNav extends SingletonAction<ShippingNavSettings> {
	override async onKeyDown(ev: KeyDownEvent<ShippingNavSettings>): Promise<void> {
		await ensureShippingProfilesLoaded();

		const direction = ev.payload.settings.direction === "prev" ? -1 : 1;
		const before = getShippingPage();
		const after = setShippingPage(before + direction);

		if (after === before && getShippingMaxPage() === 0) {
			// Nothing to page through yet (e.g. profiles not loaded) — surface that instead of a silent no-op.
			await ev.action.showAlert();
			return;
		}

		await refreshVisibleShippingSlots();
		await ev.action.showOk();
	}
}

/**
 * Settings for {@link ShippingPickerNav}.
 */
type ShippingNavSettings = {
	direction?: "prev" | "next";
};
