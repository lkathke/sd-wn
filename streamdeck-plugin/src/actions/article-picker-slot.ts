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
import { ensureListingsLoaded, getListingAtSlot } from "../state/article-picker";
import { fetchImageAsDataUri } from "../state/image-cache";

type SlotAction = KeyAction<ArticleSlotSettings> | DialAction<ArticleSlotSettings>;

const visibleSlots = new Map<string, { action: SlotAction; slotIndex: number }>();

onConnectionStatusChange(() => {
	void refreshVisibleArticleSlots();
});

/**
 * Re-renders every currently visible article-picker slot key from the cached listing list and
 * current page. Called after a page-navigation key press, and after (re)loading the listing list.
 */
export async function refreshVisibleArticleSlots(): Promise<void> {
	for (const { action: slotAction, slotIndex } of visibleSlots.values()) {
		await renderSlot(slotAction, slotIndex);
	}
}

async function renderSlot(slotAction: SlotAction, slotIndex: number): Promise<void> {
	const listing = getListingAtSlot(slotIndex);
	await slotAction.setTitle(withConnectionIndicator(listing ? listing.title : "—"));

	if (listing?.imageUrl) {
		const dataUri = await fetchImageAsDataUri(listing.imageUrl);
		if (dataUri) await slotAction.setImage(dataUri);
	}
}

/**
 * One tile of a multi-key "page" of live listings, mirroring {@link ShippingPickerSlot}. Place
 * several of these on a Stream Deck page, each with a distinct "Slot" index (0-based), plus an
 * {@link ArticlePickerNav} key or two to page through the seller's listings. Shows the product
 * thumbnail as the key image when the extension can resolve one (see src/state/article-picker.ts —
 * the exact field Whatnot uses for image URLs is unverified until tested against a live show).
 */
@action({ UUID: "com.lkathke.whatnot-controller.article-picker-slot" })
export class ArticlePickerSlot extends SingletonAction<ArticleSlotSettings> {
	override async onWillAppear(ev: WillAppearEvent<ArticleSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		visibleSlots.set(ev.action.id, { action: ev.action, slotIndex });

		await ensureListingsLoaded();
		await renderSlot(ev.action, slotIndex);
	}

	override onWillDisappear(ev: WillDisappearEvent<ArticleSlotSettings>): void {
		visibleSlots.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ArticleSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		visibleSlots.set(ev.action.id, { action: ev.action, slotIndex });
		await renderSlot(ev.action, slotIndex);
	}

	override async onKeyDown(ev: KeyDownEvent<ArticleSlotSettings>): Promise<void> {
		const slotIndex = parseInt(ev.payload.settings.slot ?? "0", 10) || 0;
		const listing = getListingAtSlot(slotIndex);

		if (!listing) {
			await ev.action.showAlert();
			return;
		}

		const sentTo = broadcastCommand({ type: "selectListing", listingId: listing.id });

		if (sentTo > 0) {
			await ev.action.showOk();
		} else {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link ArticlePickerSlot}. `slot` is a string (sdpi text field) holding a 0-based
 * index into the current page of the shared listing cache.
 */
type ArticleSlotSettings = {
	slot?: string;
};
