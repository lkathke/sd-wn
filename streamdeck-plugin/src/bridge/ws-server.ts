import streamDeck from "@elgato/streamdeck";
import { WebSocketServer, type WebSocket } from "ws";

import { setExtensionConnected } from "./connection-status";
import { setCurrentAuctionMode } from "../state/auction-mode";
import { setCurrentArticles, type ArticleInfo } from "../state/current-article";
import { setCurrentPriceCents } from "../state/current-price";
import { setCurrentShippingLabel, type ShippingTarget } from "../state/current-shipping";

const PORT = 9271;

export type WhatnotCommand =
	| { type: "setStartPrice"; price: string; currencySymbol: string }
	| { type: "setShippingMethod"; label: string; target?: "auction" | "giveaway" }
	| { type: "setAuctionDuration"; seconds: number }
	| { type: "selectListing"; listingId: string }
	| { type: "startAuction"; bumpSeconds?: number }
	| { type: "setAuctionMode"; mode: "standard" | "suddenDeath" }
	| { type: "startGiveaway" }
	| { type: "drawGiveawayWinner" }
	| { type: "pinListing" }
	| { type: "unpinListing" }
	| { type: "cycleArticle"; kind: "auction" | "giveaway" };

/**
 * One-way, extension → plugin: reports what the browser overlay bar is currently showing, so
 * price/shipping/mode display keys stay in sync when the *user edits the bar directly* instead of
 * pressing a Stream Deck key. All fields optional — the overlay only sends what's known/relevant
 * (e.g. nothing while a giveaway listing is selected, since it has no price/shipping/mode).
 */
type OverlayStateMessage = {
	type: "overlayState";
	priceCents?: number;
	shippingLabel?: string;
	mode?: "standard" | "suddenDeath";
	// Which listing this snapshot came from — the bar can only show one listing at a time, so this
	// says whether shippingLabel belongs to the auction or giveaway tracker (see
	// state/current-shipping.ts). Absent from older overlay.js builds; defaults to "auction" in
	// applyOverlayState below, matching this field's pre-existing (giveaway listings were never
	// reported at all) behavior.
	target?: ShippingTarget;
};

/**
 * One-way, extension → plugin: reports which listing currently resolves as "the auction article"
 * and "the giveaway article" (see overlay.js's resolveListingForType) — independent of which one
 * the bar's own dropdown happens to have selected. Powers the Current Auction/Giveaway Article
 * Display tiles.
 */
type ArticleStateMessage = {
	type: "articleState";
	auction: ArticleInfo;
	giveaway: ArticleInfo;
};

let wss: WebSocketServer | undefined;
let starting = false;
const clients = new Set<WebSocket>();

type PendingRequest = { resolve: (value: unknown) => void; reject: (err: Error) => void };
const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;

// When Stream Deck restarts, it doesn't always guarantee the previous plugin process has fully
// exited (and released the port) before spawning the new one. Retry a few times with a short
// delay instead of giving up on the first EADDRINUSE — the old process almost always exits within
// a second or two.
const BIND_RETRY_DELAYS_MS = [500, 1000, 2000, 3000];

/**
 * Starts the local WebSocket server the Whatnot Chrome extension connects to.
 * Safe to call multiple times; only starts once.
 */
export function startBridge(): void {
	if (wss || starting) return;
	starting = true;
	attemptBind(0);
}

function attemptBind(retryIndex: number): void {
	const server = new WebSocketServer({ port: PORT });

	server.once("listening", () => {
		wss = server;
		starting = false;
		streamDeck.logger.info(`Whatnot bridge WebSocket server listening on ws://localhost:${PORT}`);
	});

	server.on("connection", (socket) => {
		clients.add(socket);
		setExtensionConnected(true);
		streamDeck.logger.info(`Chrome extension connected (${clients.size} client(s) total).`);
		// Confirmed live: more than one connected client (e.g. two Whatnot dashboard tabs open at
		// once) means multiple overlay.js instances independently poll and report "current"
		// price/shipping/mode via overlayState — each one's report overwrites the shared global
		// setting, so whichever tab's ~1.5s refresh cycle happens to send last "wins" at any given
		// moment, making Current Price/Shipping Display flicker between two different tabs' values.
		// broadcastCommand() intentionally still fans out to all of them (a key press should reach
		// every open tab), but only one tab's overlayState reports should really be trusted — flag
		// it loudly rather than let it manifest as an unexplained flicker.
		if (clients.size > 1) {
			streamDeck.logger.warn(
				`${clients.size} Chrome extension clients connected at once — close extra Whatnot ` +
					`dashboard tabs, or price/shipping/mode display keys may flicker between tabs' values.`
			);
		}

		socket.on("message", (data) => {
			handleExtensionMessage(data.toString());
		});

		socket.on("close", () => {
			clients.delete(socket);
			setExtensionConnected(clients.size > 0);
			streamDeck.logger.info(`Chrome extension disconnected (${clients.size} client(s) remaining).`);
		});

		socket.on("error", (err) => {
			streamDeck.logger.error(`WebSocket client error: ${err.message}`);
		});
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE" && retryIndex < BIND_RETRY_DELAYS_MS.length) {
			const delay = BIND_RETRY_DELAYS_MS[retryIndex];
			streamDeck.logger.warn(
				`Port ${PORT} still in use (likely a not-yet-exited previous plugin process) — retrying in ${delay}ms.`
			);
			setTimeout(() => attemptBind(retryIndex + 1), delay);
			return;
		}

		starting = false;
		streamDeck.logger.error(`WebSocket server error: ${err.message}`);
	});
}

/**
 * Handles a raw message coming back from the extension: either a reply to a request we made via
 * {@link requestFromExtension}, or an unsolicited {@link OverlayStateMessage} reporting a change
 * the user made directly in the browser bar.
 */
function handleExtensionMessage(raw: string): void {
	let msg: {
		type?: string;
		requestId?: string;
		ok?: boolean;
		result?: unknown;
		error?: string;
		priceCents?: number;
		shippingLabel?: string;
		mode?: string;
		auction?: ArticleInfo;
		giveaway?: ArticleInfo;
	};
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}

	if (msg.type === "overlayState") {
		void applyOverlayState(msg as OverlayStateMessage);
		return;
	}

	if (msg.type === "articleState") {
		setCurrentArticles({ auction: msg.auction ?? null, giveaway: msg.giveaway ?? null });
		return;
	}

	if (msg.type !== "response" || typeof msg.requestId !== "string") return;

	const pending = pendingRequests.get(msg.requestId);
	if (!pending) return;
	pendingRequests.delete(msg.requestId);

	if (msg.ok) {
		pending.resolve(msg.result);
	} else {
		pending.reject(new Error(msg.error ?? "Unbekannter Fehler in der Chrome Extension."));
	}
}

/**
 * Mirrors an overlay state report into the same global settings a Stream Deck key press would
 * write, so Current Price/Shipping Display and Toggle Sudden Death re-render regardless of which
 * side (deck or browser bar) changed the value last.
 */
async function applyOverlayState(msg: OverlayStateMessage): Promise<void> {
	if (typeof msg.priceCents === "number" && Number.isFinite(msg.priceCents)) {
		await setCurrentPriceCents(msg.priceCents);
	}
	if (typeof msg.shippingLabel === "string" && msg.shippingLabel) {
		await setCurrentShippingLabel(msg.target ?? "auction", msg.shippingLabel);
	}
	if (msg.mode === "standard" || msg.mode === "suddenDeath") {
		await setCurrentAuctionMode(msg.mode);
	}
}

/**
 * Sends a request to the (first) connected Chrome extension client and waits for its response.
 * Used by property inspectors that need live data (e.g. shipping profiles, listings) from the
 * Whatnot page rather than a static/guessed list.
 */
export function requestFromExtension<T = unknown>(
	type: string,
	payload: Record<string, unknown> = {},
	timeoutMs = 8000
): Promise<T> {
	return new Promise((resolve, reject) => {
		const target = [...clients].find((c) => c.readyState === c.OPEN);
		if (!target) {
			reject(new Error("Keine Chrome Extension verbunden – ist das Whatnot-Live-Dashboard offen?"));
			return;
		}

		const requestId = `req_${++requestCounter}_${Date.now()}`;
		pendingRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject });

		target.send(JSON.stringify({ type, requestId, ...payload }));

		setTimeout(() => {
			if (pendingRequests.delete(requestId)) {
				reject(new Error(`Timeout beim Warten auf Antwort für ${type}.`));
			}
		}, timeoutMs);
	});
}

/**
 * Broadcasts a command to every connected Chrome extension client.
 * Returns the number of clients the command was sent to.
 */
export function broadcastCommand(command: WhatnotCommand): number {
	const payload = JSON.stringify(command);
	let sent = 0;

	for (const client of clients) {
		if (client.readyState === client.OPEN) {
			client.send(payload);
			sent++;
		}
	}

	streamDeck.logger.info(`Broadcast ${command.type} to ${sent} client(s): ${payload}`);
	return sent;
}
