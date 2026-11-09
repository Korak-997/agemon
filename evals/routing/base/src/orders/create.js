import { zoneForPostcode } from "../catalog/zones.js";
import { quoteParcel } from "../pricing/quote.js";
import { nextId } from "../util/ids.js";
import { sumCents } from "../util/money.js";
import { saveOrder } from "./store.js";
import { validateParcels } from "./validate.js";

export function createOrder(customerRef, parcels, postcode, tier = "standard") {
  validateParcels(parcels);
  const quotedParcels = parcels.map((parcel) => ({
    ...parcel,
    quote: quoteParcel(parcel, postcode, tier),
  }));
  return saveOrder({
    id: nextId("ord"),
    customerRef,
    parcels: quotedParcels,
    postcode,
    zone: zoneForPostcode(postcode),
    tier,
    status: "created",
    createdAt: new Date(),
    totalCents: sumCents(quotedParcels.map((parcel) => parcel.quote.totalCents)),
  });
}
