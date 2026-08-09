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
import { renderStaticKeyWrapped } from "../bridge/display-tile";
import { broadcastCommand, requestFromExtension } from "../bridge/ws-server";
import { setCurrentShippingLabel } from "../state/current-shipping";

const DEFAULT_BG = "#2d3138";
const DEFAULT_TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<ShippingMethodSettings>;

const visible = new Map<string, { action: SlotAction; settings: ShippingMethodSettings }>();

function formatLabel(
	settings: ShippingMethodSettings
): { text: string; bgColor: string; textColor: string } {
	const bgColor = settings.bgColor || DEFAULT_BG;
	const textColor = settings.textColor || DEFAULT_TEXT_COLOR;
	const label = resolveLabel(settings);
	if (!label) return { text: "Set Shipping", bgColor, textColor };

	const prefixed = isExtensionConnected() ? label : `⚠ ${label}`;
	return { text: prefixed, bgColor, textColor };
}

async function render(slotAction: SlotAction, settings: ShippingMethodSettings): Promise<void> {
	const { text, bgColor, textColor } = formatLabel(settings);
	await renderStaticKeyWrapped(slotAction, text, { bgColor, textColor, fontSize: 20 });
}

onConnectionStatusChange(() => {
	for (const { action: slotAction, settings } of visible.values()) void render(slotAction, settings);
});

/**
 * Sends a preset shipping method to the active Whatnot auction via the local WebSocket bridge.
 * Rendered as a solid-color tile (configurable per key) with the label as text, instead of the
 * default placeholder icon.
 */
@action({ UUID: "com.lkathke.whatnot-controller.set-shipping-method" })
export class SetShippingMethod extends SingletonAction<ShippingMethodSettings> {
	override async onWillAppear(ev: WillAppearEvent<ShippingMethodSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<ShippingMethodSettings>): void {
		visible.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ShippingMethodSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	/**
	 * The property inspector asks for the seller's real, currently configured shipping profiles
	 * instead of relying on the static/guessed dropdown list baked into the HTML.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<{ event?: string }, ShippingMethodSettings>): Promise<void> {
		if (ev.payload?.event !== "getShippingProfiles") return;

		try {
			const profiles = await requestFromExtension<ShippingProfile[]>("getShippingProfiles");
			await streamDeck.ui.sendToPropertyInspector({ event: "getShippingProfiles", profiles });
		} catch (err) {
			streamDeck.logger.warn(`Could not fetch shipping profiles from extension: ${String(err)}`);
			await streamDeck.ui.sendToPropertyInspector({ event: "getShippingProfiles", error: String(err) });
		}
	}

	override async onKeyDown(ev: KeyDownEvent<ShippingMethodSettings>): Promise<void> {
		const label = resolveLabel(ev.payload.settings);

		if (!label) {
			await ev.action.showAlert();
			return;
		}

		const target = ev.payload.settings.target ?? "auction";
		await setCurrentShippingLabel(target, label);
		const sentTo = broadcastCommand({ type: "setShippingMethod", label, target });

		// No checkmark here on purpose — the paired Current Shipping Display key flashes red instead.
		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}

function resolveLabel(settings: ShippingMethodSettings): string | undefined {
	return settings.customLabel?.trim() || settings.shippingMethod;
}

/**
 * Settings for {@link SetShippingMethod}. `bgColor`/`textColor` are hex strings from sdpi-color
 * fields. `target` picks which listing type's shipping tracker (see state/current-shipping.ts)
 * this key sets — "auction" if unset, for backward-compatible key instances that predate the
 * checkbox.
 */
type ShippingMethodSettings = {
	shippingMethod?: string;
	customLabel?: string;
	bgColor?: string;
	textColor?: string;
	target?: "auction" | "giveaway";
};

/**
 * Shape of a shipping profile as returned by bridge.js's getShippingProfiles() (see
 * whatnot-helper/src/bridge.js). Only the fields the property inspector needs are declared here.
 */
type ShippingProfile = {
	id: string;
	name: string;
};
