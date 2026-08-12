import streamDeck, {
	action,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderDisplayTextWrapped } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { ensureCustomShippingProfilesLoaded } from "../state/custom-shipping-grid";
import { getCurrentShippingLabel, onShippingChange, setCurrentShippingLabel } from "../state/current-shipping";
import { getShippingOrder, mergeWithLiveProfiles, setShippingOrder, ShippingOrderEntry } from "../state/shipping-order";

type DisplayAction = KeyAction<CurrentShippingDisplaySettings>;

const visible = new Map<string, { action: DisplayAction; settings: CurrentShippingDisplaySettings }>();

function formatShipping(label: string): { text: string } {
	const text = label || "—";
	return { text: isExtensionConnected() ? text : `⚠ ${text}` };
}

async function render(
	displayAction: DisplayAction,
	settings: CurrentShippingDisplaySettings,
	changed: boolean
): Promise<void> {
	const label = await getCurrentShippingLabel(settings.target ?? "auction");
	const { text } = formatShipping(label);
	await renderDisplayTextWrapped(displayAction, text, 22, changed);
}

onShippingChange((target) => {
	for (const { action: displayAction, settings } of visible.values()) {
		if ((settings.target ?? "auction") === target) void render(displayAction, settings, true);
	}
});
onConnectionStatusChange(() => {
	for (const { action: displayAction, settings } of visible.values()) void render(displayAction, settings, false);
});

/**
 * Read-only tile showing the shared "current shipping method" (see src/state/current-shipping.ts)
 * as a self-drawn image, flashing the text red briefly whenever it changes. Mirrors
 * {@link CurrentPriceDisplay} — see its comment for why this doesn't open a menu on press. Its
 * property inspector also doubles as the config surface for the shared shipping order/enabled list
 * that {@link AdjustShippingMethod} steps through (see src/state/shipping-order.ts) — there's no
 * more natural place for it since it's global config, not tied to any specific key.
 */
@action({ UUID: "com.lkathke.whatnot-controller.current-shipping-display" })
export class CurrentShippingDisplay extends SingletonAction<CurrentShippingDisplaySettings> {
	override async onWillAppear(ev: WillAppearEvent<CurrentShippingDisplaySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings, false);
	}

	override onWillDisappear(ev: WillDisappearEvent<CurrentShippingDisplaySettings>): void {
		visible.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CurrentShippingDisplaySettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings, false);
	}

	override async onSendToPlugin(
		ev: SendToPluginEvent<{ event?: string; order?: ShippingOrderEntry[] }, CurrentShippingDisplaySettings>
	): Promise<void> {
		switch (ev.payload?.event) {
			case "getShippingOrderConfig":
				await this.sendOrderConfig();
				return;
			case "setShippingOrderConfig":
				if (ev.payload.order) await setShippingOrder(ev.payload.order);
				return;
			default:
				return;
		}
	}

	private async sendOrderConfig(): Promise<void> {
		try {
			const [profiles, saved] = await Promise.all([ensureCustomShippingProfilesLoaded(true), getShippingOrder()]);
			const merged = mergeWithLiveProfiles(
				saved,
				profiles.map((p) => p.name)
			);
			await streamDeck.ui.sendToPropertyInspector({ event: "getShippingOrderConfig", order: merged });
		} catch (err) {
			streamDeck.logger.warn(`Could not build shipping order config: ${String(err)}`);
			await streamDeck.ui.sendToPropertyInspector({ event: "getShippingOrderConfig", error: String(err) });
		}
	}

	override async onKeyDown(ev: KeyDownEvent<CurrentShippingDisplaySettings>): Promise<void> {
		// Always resets to the lightest custom profile (list is already weight-sorted ascending —
		// see state/custom-shipping-grid.ts) rather than a configurable default — no PI setting to
		// keep in sync/go stale.
		const profiles = await ensureCustomShippingProfilesLoaded();
		const label = profiles[0]?.name;
		if (!label) {
			await ev.action.showAlert();
			return;
		}

		const target = ev.payload.settings.target ?? "auction";
		await setCurrentShippingLabel(target, label);
		const sentTo = broadcastCommand({ type: "setShippingMethod", label, target });

		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link CurrentShippingDisplay}. `target` picks which listing type's shipping
 * tracker (see state/current-shipping.ts) this key shows/resets — "auction" if unset, for
 * backward-compatible key instances that predate the checkbox.
 */
type CurrentShippingDisplaySettings = {
	target?: "auction" | "giveaway";
};
