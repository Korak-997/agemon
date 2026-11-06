import assert from "node:assert/strict";
import { test } from "node:test";
import { assignToVans } from "../src/dispatch/assign.js";
import { buildManifest } from "../src/dispatch/manifest.js";
import { createOrder } from "../src/orders/create.js";
import { smallParcel } from "./helpers.js";

test("orders over a van's capacity open another van", () => {
  const heavy = Array.from({ length: 12 }, () => smallParcel({ weightKg: 70 }));
  const first = createOrder({ accountId: "cust-1", parcels: heavy, postcode: "10115" });
  const second = createOrder({ accountId: "cust-2", parcels: heavy, postcode: "10115" });
  const vans = assignToVans([first, second]);
  assert.equal(vans.length, 2);
});

test("the manifest lists each order on its route", () => {
  const order = createOrder({ accountId: "cust-1", parcels: [smallParcel()], postcode: "40210" });
  const [van] = assignToVans([order]);
  assert.deepEqual(buildManifest(van).lines, [
    { orderId: order.id, account: "cust-1", route: "north-ring", parcelCount: 1 },
  ]);
});
