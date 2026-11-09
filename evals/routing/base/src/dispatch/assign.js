import { sumCents } from "../util/money.js";
import { newVan, vanFits } from "./capacity.js";

function orderWeightKg(order) {
  return sumCents(order.parcels.map((parcel) => parcel.weightKg));
}

function orderFits(van, order) {
  return vanFits(van, {
    weightKg: orderWeightKg(order),
    lengthCm: Math.max(...order.parcels.map((parcel) => parcel.lengthCm)),
    widthCm: 0,
    heightCm: 0,
  });
}

export function assignToVans(orders) {
  const vans = [];
  for (const order of orders) {
    let van = vans.find((candidate) => orderFits(candidate, order));
    if (!van) {
      van = newVan(`van-${vans.length + 1}`);
      vans.push(van);
    }
    van.loadKg += orderWeightKg(order);
    van.orders.push(order);
  }
  return vans;
}
