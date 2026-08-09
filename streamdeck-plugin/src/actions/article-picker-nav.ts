import { action, KeyDownEvent, SingletonAction } from "@elgato/streamdeck";

import { refreshVisibleArticleSlots } from "./article-picker-slot";
import { ensureListingsLoaded, getArticleMaxPage, getArticlePage, setArticlePage } from "../state/article-picker";

/**
 * Pages the shared article/listing picker forward or backward, then refreshes every currently
 * visible {@link ArticlePickerSlot} key to reflect the new page. Mirrors {@link ShippingPickerNav}.
 */
@action({ UUID: "com.lkathke.whatnot-controller.article-picker-nav" })
export class ArticlePickerNav extends SingletonAction<ArticleNavSettings> {
	override async onKeyDown(ev: KeyDownEvent<ArticleNavSettings>): Promise<void> {
		await ensureListingsLoaded();

		const direction = ev.payload.settings.direction === "prev" ? -1 : 1;
		const before = getArticlePage();
		const after = setArticlePage(before + direction);

		if (after === before && getArticleMaxPage() === 0) {
			await ev.action.showAlert();
			return;
		}

		await refreshVisibleArticleSlots();
		await ev.action.showOk();
	}
}

/**
 * Settings for {@link ArticlePickerNav}.
 */
type ArticleNavSettings = {
	direction?: "prev" | "next";
};
