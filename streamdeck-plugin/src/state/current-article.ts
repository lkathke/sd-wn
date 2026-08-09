export type ArticleInfo = { id: string; title: string; imageUrl?: string } | null;

type Listener = () => void;

// Ephemeral, in-memory only (unlike current-price.ts/current-shipping.ts, which persist to global
// settings) — this mirrors whatever overlay.js's resolveListingForType() currently resolves to,
// re-sent on every relevant browser-side change (see its sendArticleState()), so persisting it
// across a plugin restart would just show stale data until the next overlay update anyway.
let auction: ArticleInfo = null;
let giveaway: ArticleInfo = null;
const listeners = new Set<Listener>();

export function getCurrentArticle(kind: "auction" | "giveaway"): ArticleInfo {
	return kind === "auction" ? auction : giveaway;
}

export function setCurrentArticles(next: { auction: ArticleInfo; giveaway: ArticleInfo }): void {
	auction = next.auction;
	giveaway = next.giveaway;
	for (const listener of listeners) listener();
}

/** Subscribes to changes of either current article, e.g. for a display key that re-renders on update. */
export function onCurrentArticleChange(listener: Listener): void {
	listeners.add(listener);
}
