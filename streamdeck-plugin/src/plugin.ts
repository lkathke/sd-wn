import streamDeck from "@elgato/streamdeck";

import { AdjustShippingMethod } from "./actions/adjust-shipping-method";
import { AdjustStartPrice } from "./actions/adjust-start-price";
import { ArticlePickerNav } from "./actions/article-picker-nav";
import { ArticlePickerSlot } from "./actions/article-picker-slot";
import { CurrentAuctionArticleDisplay } from "./actions/current-auction-article-display";
import { CurrentGiveawayArticleDisplay } from "./actions/current-giveaway-article-display";
import { CurrentPriceDisplay } from "./actions/current-price-display";
import { CurrentShippingDisplay } from "./actions/current-shipping-display";
import { CycleAuctionDuration } from "./actions/cycle-auction-duration";
import { DrawGiveawayWinnerButton } from "./actions/draw-giveaway-winner-button";
import { PinListingButton } from "./actions/pin-listing-button";
import { SetAuctionDuration } from "./actions/set-auction-duration";
import { SetShippingMethod } from "./actions/set-shipping-method";
import { SetStartPrice } from "./actions/set-start-price";
import { ShippingPickerNav } from "./actions/shipping-picker-nav";
import { ShippingPickerSlot } from "./actions/shipping-picker-slot";
import { StartAuctionButton } from "./actions/start-auction-button";
import { StartGiveawayButton } from "./actions/start-giveaway-button";
import { ToggleSuddenDeath } from "./actions/toggle-sudden-death";
import { UnpinListingButton } from "./actions/unpin-listing-button";
import { startBridge } from "./bridge/ws-server";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// A single unhandled rejection/exception in any action handler would otherwise crash this whole
// process, taking every key on the deck down with it (this actually happened during development —
// see the shipping-picker-slot fix). Log and keep running instead.
process.on("unhandledRejection", (reason) => {
	streamDeck.logger.error(`Unhandled promise rejection: ${String(reason)}`);
});
process.on("uncaughtException", (err) => {
	streamDeck.logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
});

// Start the local WebSocket bridge the Whatnot Chrome extension will connect to.
startBridge();

// Register the actions.
streamDeck.actions.registerAction(new SetStartPrice());
streamDeck.actions.registerAction(new AdjustStartPrice());
streamDeck.actions.registerAction(new SetShippingMethod());
streamDeck.actions.registerAction(new SetAuctionDuration());
streamDeck.actions.registerAction(new ShippingPickerSlot());
streamDeck.actions.registerAction(new ShippingPickerNav());
streamDeck.actions.registerAction(new ArticlePickerSlot());
streamDeck.actions.registerAction(new ArticlePickerNav());
streamDeck.actions.registerAction(new CurrentPriceDisplay());
streamDeck.actions.registerAction(new CurrentShippingDisplay());
streamDeck.actions.registerAction(new AdjustShippingMethod());
streamDeck.actions.registerAction(new CycleAuctionDuration());
streamDeck.actions.registerAction(new StartAuctionButton());
streamDeck.actions.registerAction(new ToggleSuddenDeath());
streamDeck.actions.registerAction(new StartGiveawayButton());
streamDeck.actions.registerAction(new DrawGiveawayWinnerButton());
streamDeck.actions.registerAction(new PinListingButton());
streamDeck.actions.registerAction(new UnpinListingButton());
streamDeck.actions.registerAction(new CurrentAuctionArticleDisplay());
streamDeck.actions.registerAction(new CurrentGiveawayArticleDisplay());

// Finally, connect to the Stream Deck.
streamDeck.connect();
