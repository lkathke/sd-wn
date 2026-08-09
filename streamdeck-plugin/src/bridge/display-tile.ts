import type { KeyAction } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

const NORMAL_TEXT_COLOR = "#ffffff";
const CHANGED_TEXT_COLOR = "#e74c3c";
const DISPLAY_BG_COLOR = "#14161a";
const FLASH_MS = 600;

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders a whole key as a single centered line of text on a solid background, entirely via SVG —
 * Stream Deck's own title overlay can't be recolored or given a background per-call, so any key
 * that needs that has to draw its own text into the image instead of using
 * {@link KeyAction.setTitle} + the manifest's static key image.
 *
 * Vertical centering deliberately doesn't rely on `dominant-baseline` (support for it is
 * inconsistent across the Qt WebEngine versions different Stream Deck app releases embed) —
 * instead it nudges the alphabetic-baseline `y` down by a fraction of the font size, a simpler
 * technique that renders consistently everywhere.
 */
function renderSvg(text: string, textColor: string, bgColor: string, fontSize: number): string {
	const y = 72 + fontSize * 0.35;
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">` +
		`<rect width="144" height="144" fill="${bgColor}"/>` +
		`<text x="72" y="${y}" font-size="${fontSize}" font-family="system-ui, sans-serif" font-weight="700" ` +
		`fill="${textColor}" text-anchor="middle">${escapeXml(text)}</text>` +
		`</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Draws `text` on a fixed-color background (e.g. green/red for a +/- key) — no flashing, just a
 * static, always-current rendering of the key's own settings.
 */
export async function renderStaticKey<T extends JsonObject>(
	keyAction: KeyAction<T>,
	text: string,
	options: { bgColor: string; textColor: string; fontSize: number }
): Promise<void> {
	await keyAction.setTitle("");
	await keyAction.setImage(renderSvg(text, options.textColor, options.bgColor, options.fontSize));
}

/**
 * Word-wraps `text` into at most `maxLines` lines of roughly `maxCharsPerLine` characters each,
 * truncating the last line with an ellipsis if there's leftover content. No canvas/DOM available
 * in the plugin's Node process to measure real text width, so this uses a fixed average-character-
 * width estimate instead — good enough for a small key label, not pixel-perfect.
 */
function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= maxCharsPerLine || !current) {
			current = candidate;
		} else {
			lines.push(current);
			current = word;
			if (lines.length === maxLines) break;
		}
	}
	if (lines.length < maxLines && current) lines.push(current);

	const consumedWords = lines.join(" ").split(/\s+/).length;
	if (lines.length === maxLines && consumedWords < words.length) {
		let last = lines[maxLines - 1];
		while (last.length > 1 && last.length + 1 > maxCharsPerLine) last = last.slice(0, -1);
		lines[maxLines - 1] = `${last.trimEnd()}…`;
	}

	return lines;
}

type TileLine = string | { text: string; fontSize?: number; gapBefore?: number };

// Shared layout math for "N centered, vertically-stacked lines" — used both by the auto-wrapping
// renderer below and by callers that already know their exact line breaks (e.g. a fixed status
// word on its own final line) and want to skip the word-wrap heuristic entirely. Line height is
// based on the *default* font size even when individual lines override it, so an oversized line
// (e.g. a big "!") doesn't shove its neighbors around — it just grows in place. `gapBefore` adds
// extra pixels ahead of a specific line, e.g. to visually separate a trailing icon line from the
// text above it.
function renderLinesSvg(lines: TileLine[], textColor: string, bgColor: string, fontSize: number): string {
	const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 20;
	const safeLines = lines.length > 0 ? lines : [" "];

	const lineHeight = safeFontSize * 1.15;
	const gapsBefore = safeLines.map((line) => (typeof line === "string" ? 0 : (line.gapBefore ?? 0)));
	const totalGap = gapsBefore.reduce((sum, g) => sum + g, 0);
	const totalHeight = (safeLines.length - 1) * lineHeight + totalGap;
	let y = 72 - totalHeight / 2 + safeFontSize * 0.35;

	// Separate <text> elements per line instead of <tspan>s within one <text> — more reliably
	// positioned across renderers, including the older Qt WebEngine some Stream Deck app releases
	// embed (this replaced a tspan-based version that rendered as a near-empty tile).
	const textElements = safeLines
		.map((line, i) => {
			const text = typeof line === "string" ? line : line.text;
			const lineFontSize = typeof line === "string" ? safeFontSize : (line.fontSize ?? safeFontSize);
			if (i > 0) y += lineHeight + gapsBefore[i];
			return (
				`<text x="72" y="${y}" font-size="${lineFontSize}" ` +
				`font-family="system-ui, sans-serif" font-weight="700" fill="${textColor}" text-anchor="middle">` +
				`${escapeXml(text)}</text>`
			);
		})
		.join("");

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">` +
		`<rect width="144" height="144" fill="${bgColor}"/>${textElements}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function renderWrappedSvg(text: string, textColor: string, bgColor: string, fontSize: number, maxLines: number): string {
	// ~0.58 is a reasonable average glyph-width-to-font-size ratio for a bold sans-serif face.
	const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 20;
	const maxCharsPerLine = Math.max(3, Math.floor(136 / (safeFontSize * 0.58)));
	const lines = wrapLines(text, maxCharsPerLine, maxLines);
	if (lines.length === 0) lines.push(text || " ");
	return renderLinesSvg(lines, textColor, bgColor, safeFontSize);
}

/**
 * Like {@link renderStaticKey}, but word-wraps long text across up to `maxLines` lines instead of
 * just shrinking the font — for labels (shipping profile names, etc.) that can be long and would
 * otherwise become unreadably tiny on a single line.
 */
export async function renderStaticKeyWrapped<T extends JsonObject>(
	keyAction: KeyAction<T>,
	text: string,
	options: { bgColor: string; textColor: string; fontSize: number; maxLines?: number }
): Promise<void> {
	await keyAction.setTitle("");
	await keyAction.setImage(
		renderWrappedSvg(text, options.textColor, options.bgColor, options.fontSize, options.maxLines ?? 3)
	);
}

/**
 * Like {@link renderStaticKeyWrapped}, but takes the exact lines to draw instead of word-wrapping
 * one string — for callers that need a specific line, like a status word or icon, pinned to its
 * own line regardless of how the rest of the text would wrap.
 */
export async function renderStaticKeyLines<T extends JsonObject>(
	keyAction: KeyAction<T>,
	lines: TileLine[],
	options: { bgColor: string; textColor: string; fontSize: number }
): Promise<void> {
	await keyAction.setTitle("");
	await keyAction.setImage(renderLinesSvg(lines, options.textColor, options.bgColor, options.fontSize));
}

function renderTwoLineSvg(
	topText: string,
	bottomText: string,
	textColor: string,
	bgColor: string,
	topFontSize: number,
	bottomFontSize: number
): string {
	const topY = 62 + topFontSize * 0.35;
	const bottomY = topY + topFontSize * 0.55 + bottomFontSize * 0.8;
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">` +
		`<rect width="144" height="144" fill="${bgColor}"/>` +
		`<text x="72" y="${topY}" font-size="${topFontSize}" font-family="system-ui, sans-serif" ` +
		`fill="${textColor}" text-anchor="middle">${escapeXml(topText)}</text>` +
		`<text x="72" y="${bottomY}" font-size="${bottomFontSize}" font-family="system-ui, sans-serif" ` +
		`font-weight="700" fill="${textColor}" text-anchor="middle">${escapeXml(bottomText)}</text>` +
		`</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Like {@link renderStaticKey}, but draws two centered lines — e.g. a large icon/emoji on top with
 * a smaller label underneath, for keys where a single line reads as cramped.
 */
export async function renderStaticKeyTwoLine<T extends JsonObject>(
	keyAction: KeyAction<T>,
	topText: string,
	bottomText: string,
	options: { bgColor: string; textColor: string; topFontSize: number; bottomFontSize: number }
): Promise<void> {
	await keyAction.setTitle("");
	await keyAction.setImage(
		renderTwoLineSvg(topText, bottomText, options.textColor, options.bgColor, options.topFontSize, options.bottomFontSize)
	);
}

// Tracks the pending "revert to white" timer per key, keyed by action id. Without this, rapid
// repeated presses (+/- spammed quickly) race: an older press's revert-timer fires *after* a newer
// press has already drawn the current value, overwriting it with the stale text it captured.
const pendingRevert = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Draws `text` on the standard dark display background, briefly in red when `changed` is true,
 * then automatically reverting to white after a short delay — the flash-on-change feedback for the
 * price/shipping display tiles. Safe to call again before a previous flash has finished; the
 * earlier revert is cancelled so it can never clobber a newer value.
 */
export async function renderDisplayText<T extends JsonObject>(
	keyAction: KeyAction<T>,
	text: string,
	fontSize: number,
	changed: boolean
): Promise<void> {
	const pending = pendingRevert.get(keyAction.id);
	if (pending) {
		clearTimeout(pending);
		pendingRevert.delete(keyAction.id);
	}

	await keyAction.setTitle("");
	await keyAction.setImage(renderSvg(text, changed ? CHANGED_TEXT_COLOR : NORMAL_TEXT_COLOR, DISPLAY_BG_COLOR, fontSize));

	if (changed) {
		const handle = setTimeout(() => {
			pendingRevert.delete(keyAction.id);
			void keyAction.setImage(renderSvg(text, NORMAL_TEXT_COLOR, DISPLAY_BG_COLOR, fontSize));
		}, FLASH_MS);
		pendingRevert.set(keyAction.id, handle);
	}
}

/**
 * Word-wrapping counterpart to {@link renderDisplayText} — for display tiles whose value can be
 * long free text (shipping profile names) rather than a short number.
 */
export async function renderDisplayTextWrapped<T extends JsonObject>(
	keyAction: KeyAction<T>,
	text: string,
	fontSize: number,
	changed: boolean,
	maxLines = 3
): Promise<void> {
	const pending = pendingRevert.get(keyAction.id);
	if (pending) {
		clearTimeout(pending);
		pendingRevert.delete(keyAction.id);
	}

	await keyAction.setTitle("");
	await keyAction.setImage(
		renderWrappedSvg(text, changed ? CHANGED_TEXT_COLOR : NORMAL_TEXT_COLOR, DISPLAY_BG_COLOR, fontSize, maxLines)
	);

	if (changed) {
		const handle = setTimeout(() => {
			pendingRevert.delete(keyAction.id);
			void keyAction.setImage(renderWrappedSvg(text, NORMAL_TEXT_COLOR, DISPLAY_BG_COLOR, fontSize, maxLines));
		}, FLASH_MS);
		pendingRevert.set(keyAction.id, handle);
	}
}
