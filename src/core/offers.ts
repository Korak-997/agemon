import type { AgemonPlugin, Offer } from "../plugins/types.js";
import { findCapabilityOffers } from "./capability-migration.js";
import type { AgemonConfig } from "./config.js";
import type { Context } from "./context.js";
import { printable } from "./untrusted-text.js";

const OFFER_KIND_LABEL: Record<Offer["kind"], string> = {
  capability: "capability",
  "skill-group": "skill group",
};

export function findOffers(
  ctx: Context,
  plugins: AgemonPlugin[],
  config: AgemonConfig | null,
): Offer[] {
  if (config === null) {
    return [];
  }
  return [
    ...findCapabilityOffers(config, plugins),
    ...plugins
      .filter((plugin) => config.capabilities.includes(plugin.id))
      .flatMap((plugin) => plugin.listOffers?.(ctx) ?? []),
  ];
}

function nameOffers(offers: Offer[]): string {
  return offers
    .map((offer) => `${OFFER_KIND_LABEL[offer.kind]} '${printable(offer.id)}'`)
    .join(", ");
}

export function describeOffers(offers: Offer[]): string[] {
  const newOffers = offers.filter((offer) => offer.state === "new");
  const declinedOffers = offers.filter((offer) => offer.state === "declined");
  return [
    ...(newOffers.length > 0
      ? [`New: ${nameOffers(newOffers)}. Run 'agemon' to choose.`]
      : []),
    ...(declinedOffers.length > 0
      ? [
          `Declined: ${nameOffers(declinedOffers)}. Run 'agemon add <name>' to install.`,
        ]
      : []),
  ];
}
