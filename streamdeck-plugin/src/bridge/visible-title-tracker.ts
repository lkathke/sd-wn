import type { DialAction, KeyAction } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { onConnectionStatusChange, withConnectionIndicator } from "./connection-status";

type TrackedAction<T extends JsonObject> = KeyAction<T> | DialAction<T>;

/**
 * Keeps a key's title in sync with both its own settings and the Chrome extension connection
 * status, without every action file re-implementing the "track visible contexts, re-render on
 * connection change" bookkeeping itself.
 */
export function trackTitle<T extends JsonObject>(formatTitle: (settings: T) => string) {
	const visible = new Map<string, { action: TrackedAction<T>; settings: T }>();

	onConnectionStatusChange(() => {
		for (const { action, settings } of visible.values()) {
			void action.setTitle(withConnectionIndicator(formatTitle(settings)));
		}
	});

	function render(action: TrackedAction<T>, settings: T): Promise<void> {
		visible.set(action.id, { action, settings });
		return action.setTitle(withConnectionIndicator(formatTitle(settings)));
	}

	return {
		show: render,
		update: render,
		hide(actionId: string): void {
			visible.delete(actionId);
		}
	};
}
