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
    })),
  };
}
