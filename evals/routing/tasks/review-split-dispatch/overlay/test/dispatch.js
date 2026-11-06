import assert from "node:assert/strict";
import { test } from "node:test";
import { assignToVans } from "../src/dispatch/assign.js";
import { buildManifest, ordersSplitAcrossVans } from "../src/dispatch/manifest.js";
import { createOrder } from "../src/orders/create.js";
import { smallParcel } from "./helpers.js";

test("orders over a van's capacity open another van", () => {
  const heavy = Array.from({ length: 12 }, () => smallParcel({ weightKg: 70 }));
  const first = createOrder("cust-1", heavy, "10115");
  const second = createOrder("cust-2", heavy, "10115");
  const vans = assignToVans([first, second]);
  assert.equal(vans.length, 2);
});

test("the manifest lists each order on its route", () => {
  const order = createOrder("cust-1", [smallParcel()], "40210");
  const [van] = assignToVans([order]);
  assert.deepEqual(buildManifest(van).lines, [
    {
      orderId: order.id,
      customer: "cust-1",
      route: "north-ring",
      parcelCount: 1,
      weightKg: 2,
    },
  ]);
});

test("a parcel that no longer fits goes on the next van", () => {
  const nearlyFull = Array.from({ length: 11 }, () => smallParcel({ weightKg: 70 }));
  const first = createOrder("cust-1", nearlyFull, "10115");
  const second = createOrder("cust-2", [smallParcel({ weightKg: 60 })], "10115");
  const vans = assignToVans([first, second]);
  assert.equal(vans.length, 2);
  assert.deepEqual(ordersSplitAcrossVans(vans), []);
});
