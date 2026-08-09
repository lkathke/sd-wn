type Listener = (connected: boolean) => void;

const listeners = new Set<Listener>();
let connected = false;

/**
 * Updates whether at least one Chrome extension client is connected to the bridge, and notifies
 * subscribers if the value actually changed.
 */
export function setExtensionConnected(value: boolean): void {
	if (connected === value) return;
	connected = value;
	for (const listener of listeners) listener(value);
}

export function isExtensionConnected(): boolean {
	return connected;
}

/**
 * Subscribes to connection status changes. There is no need to unsubscribe — the plugin process
 * lives for as long as Stream Deck runs it, so listeners registered once at module load are fine.
 */
export function onConnectionStatusChange(listener: Listener): void {
	listeners.add(listener);
}

/**
 * Prefixes a key title with a warning glyph when no Chrome extension is connected, so a press
 * fails visibly and predictably instead of silently doing nothing.
 */
export function withConnectionIndicator(title: string): string {
	return isExtensionConnected() ? title : `⚠ ${title}`;
}
