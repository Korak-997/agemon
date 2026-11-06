import { VAN_CAPACITY_KG, VAN_LONGEST_SIDE_LIMIT_CM } from "../config.js";

export function isOversize(parcel) {
  return (
    Math.max(parcel.lengthCm, parcel.widthCm, parcel.heightCm) >
    VAN_LONGEST_SIDE_LIMIT_CM
  );
}

export function newVan(id) {
  return { id, capacityKg: VAN_CAPACITY_KG, loadKg: 0, orders: [] };
}

export function vanFits(van, parcel) {
  return !isOversize(parcel) && van.loadKg + parcel.weightKg <= van.capacityKg;
}
