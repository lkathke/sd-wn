import streamDeck from "@elgato/streamdeck";

const cache = new Map<string, string>();

/**
 * Fetches an image URL and returns it as a base64 data URI suitable for {@link KeyAction.setImage}.
 * Results are cached in-memory by URL for the lifetime of the plugin process — listing thumbnails
 * don't change once a listing exists.
 */
export async function fetchImageAsDataUri(url: string): Promise<string | undefined> {
	const cached = cache.get(url);
	if (cached) return cached;

	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const contentType = res.headers.get("content-type") ?? "image/jpeg";
		const buffer = Buffer.from(await res.arrayBuffer());
		const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;

		cache.set(url, dataUri);
		return dataUri;
	} catch (err) {
		streamDeck.logger.warn(`Could not fetch image ${url}: ${String(err)}`);
		return undefined;
	}
}
