import {
	action,
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent
} from "@elgato/streamdeck";

import { isExtensionConnected, onConnectionStatusChange } from "../bridge/connection-status";
import { renderStaticKey } from "../bridge/display-tile";
import { broadcastCommand } from "../bridge/ws-server";
import { getCurrentShippingLabel, setCurrentShippingLabel } from "../state/current-shipping";
import { ensureShippingProfilesLoaded } from "../state/shipping-picker";
import { getEnabledShippingOrder } from "../state/shipping-order";

const BG_COLOR = "#2d6cdf";
const TEXT_COLOR = "#ffffff";

type SlotAction = KeyAction<AdjustShippingSettings>;

const visible = new Map<string, { action: SlotAction; settings: AdjustShippingSettings }>();

function formatLabel(settings: AdjustShippingSettings): { text: string } {
	const glyph = settings.direction === "prev" ? "◀" : "▶";
	return { text: isExtensionConnected() ? glyph : `⚠${glyph}` };
}

async function render(slotAction: SlotAction, settings: AdjustShippingSettings): Promise<void> {
	const { text } = formatLabel(settings);
	await renderStaticKey(slotAction, text, { bgColor: BG_COLOR, textColor: TEXT_COLOR, fontSize: 44 });
}

onConnectionStatusChange(() => {
	for (const { action: slotAction, settings } of visible.values()) void render(slotAction, settings);
});

/**
 * Steps the current shipping method forward or backward through the seller's configured shipping
 * order (see src/state/shipping-order.ts — disabled profiles are skipped, order is user-defined via
 * Current Shipping Display's property inspector), wrapping around at either end. Falls back to the
 * full live profile list, unfiltered, until that's been configured — an alternative to the grid
 * picker for a "just cycle through them" workflow.
 */
@action({ UUID: "com.lkathke.whatnot-controller.adjust-shipping-method" })
export class AdjustShippingMethod extends SingletonAction<AdjustShippingSettings> {
	override async onWillAppear(ev: WillAppearEvent<AdjustShippingSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<AdjustShippingSettings>): void {
		visible.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AdjustShippingSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings });
		await render(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<AdjustShippingSettings>): Promise<void> {
		const liveProfiles = await ensureShippingProfilesLoaded();
		const order = await getEnabledShippingOrder(liveProfiles.map((p) => p.name));
		if (order.length === 0) {
			await ev.action.showAlert();
			return;
		}

		const target = ev.payload.settings.target ?? "auction";
		const current = await getCurrentShippingLabel(target);
		const currentIndex = order.indexOf(current);
		const direction = ev.payload.settings.direction === "prev" ? -1 : 1;
		const nextIndex = ((currentIndex === -1 ? 0 : currentIndex) + direction + order.length) % order.length;
		const nextLabel = order[nextIndex];

		await setCurrentShippingLabel(target, nextLabel);
		const sentTo = broadcastCommand({ type: "setShippingMethod", label: nextLabel, target });

		if (sentTo === 0) {
			await ev.action.showAlert();
		}
	}
}

/**
 * Settings for {@link AdjustShippingMethod}. `target` picks which listing type's shipping tracker
 * (see state/current-shipping.ts) this key steps through — "auction" if unset, for
 * backward-compatible key instances that predate the checkbox.
 */
type AdjustShippingSettings = {
	direction?: "prev" | "next";
	target?: "auction" | "giveaway";
};
