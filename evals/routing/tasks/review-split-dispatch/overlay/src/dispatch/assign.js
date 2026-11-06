import { sumCents } from "../util/money.js";
import { newVan, vanFits } from "./capacity.js";

function parcelsThatFit(van, parcels) {
  const fitted = [];
  for (const parcel of parcels) {
    if (vanFits(van, parcel)) fitted.push(parcel);
  }
  return fitted;
}

function loadParcels(van, order, parcels) {
  van.loadKg += sumCents(parcels.map((parcel) => parcel.weightKg));
  van.orders.push({ ...order, parcels });
}

function openVan(vans) {
  const van = newVan(`van-${vans.length + 1}`);
  vans.push(van);
  return van;
}

export function assignToVans(orders) {
  const vans = [];
  for (const order of orders) {
    let remaining = order.parcels;
    while (remaining.length > 0) {
      const van =
        vans.find((candidate) => parcelsThatFit(candidate, remaining).length > 0) ??
        openVan(vans);
      const fitted = parcelsThatFit(van, remaining);
      const loaded = fitted.length > 0 ? fitted : remaining.slice(0, 1);
      loadParcels(van, order, loaded);
      remaining = remaining.filter((parcel) => !loaded.includes(parcel));
    }
  }
  return vans;
}
