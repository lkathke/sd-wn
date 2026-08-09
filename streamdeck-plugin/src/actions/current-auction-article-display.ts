import { action, KeyAction, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange, withConnectionIndicator } from "../bridge/connection-status";
import { broadcastCommand } from "../bridge/ws-server";
import { getCurrentArticle, onCurrentArticleChange } from "../state/current-article";
import { fetchImageAsDataUri } from "../state/image-cache";

type SlotAction = KeyAction<Record<string, never>>;

const visible = new Set<SlotAction>();

async function render(slotAction: SlotAction): Promise<void> {
	const article = getCurrentArticle("auction");
	await slotAction.setTitle(withConnectionIndicator(article ? article.title : "—"));
	if (article?.imageUrl) {
		const dataUri = await fetchImageAsDataUri(article.imageUrl);
		if (dataUri) await slotAction.setImage(dataUri);
	} else {
		await slotAction.setImage();
	}
}

onCurrentArticleChange(() => {
	for (const slotAction of visible) void render(slotAction);
});
onConnectionStatusChange(() => {
	for (const slotAction of visible) void render(slotAction);
});

/**
 * Shows whichever listing currently resolves as "the auction article" (see overlay.js's
 * resolveListingForType(false)) — the same one every auction-related Stream Deck key (start
 * price, shipping, duration, pin, start auction, ...) implicitly acts on when no listing is
 * explicitly selected in the overlay bar. Pressing cycles to the next auction-type listing,
 * wrapping around (lands back on itself if there's only one) — mirrors this key's giveaway
 * counterpart, {@link CurrentGiveawayArticleDisplay}.
 */
@action({ UUID: "com.lkathke.whatnot-controller.current-auction-article-display" })
export class CurrentAuctionArticleDisplay extends SingletonAction<Record<string, never>> {
	override async onWillAppear(ev: WillAppearEvent<Record<string, never>>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.add(ev.action);
		await render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<Record<string, never>>): void {
		visible.delete(ev.action as SlotAction);
	}

	override async onKeyDown(ev: KeyDownEvent<Record<string, never>>): Promise<void> {
		if (!isExtensionConnected()) {
			await ev.action.showAlert();
			return;
		}
		const sentTo = broadcastCommand({ type: "cycleArticle", kind: "auction" });
		// No showOk() here — the image itself updates once the extension reports the new current
		// article (see onCurrentArticleChange above), which is confirmation enough on its own.
		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}
