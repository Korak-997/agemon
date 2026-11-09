import { sumCents } from "../util/money.js";
import { routeForZone } from "./routes.js";

export function buildManifest(van) {
  return {
    vanId: van.id,
    loadKg: van.loadKg,
    lines: van.orders.map((order) => ({
      orderId: order.id,
      customer: order.customerRef,
      route: routeForZone(order.zone),
      parcelCount: order.parcels.length,
      weightKg: sumCents(order.parcels.map((parcel) => parcel.weightKg)),
    })),
  };
}

export function ordersSplitAcrossVans(vans) {
  const vanIdsByOrder = new Map();
  for (const van of vans) {
    for (const order of van.orders) {
      const vanIds = vanIdsByOrder.get(order.id) ?? [];
      vanIdsByOrder.set(order.id, [...vanIds, van.id]);
    }
  }
  return [...vanIdsByOrder].filter(([, vanIds]) => vanIds.length > 1);
}
