import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { balanceFor, clearLedger } from "../src/billing/ledger.js";
import { cancelOrder } from "../src/orders/cancel.js";
import { createOrder } from "../src/orders/create.js";
import { clearOrders, ordersForCustomer } from "../src/orders/store.js";
import { smallParcel } from "./helpers.js";

beforeEach(() => {
  clearOrders();
  clearLedger();
});

test("orders are stored under their customer", () => {
  const order = createOrder("cust-1", [smallParcel()], "10115");
  createOrder("cust-2", [smallParcel()], "10115");
  assert.deepEqual(ordersForCustomer("cust-1"), [order]);
});

test("an order without parcels is rejected", () => {
  assert.throws(() => createOrder("cust-1", [], "10115"), /needs a parcel/);
});

test("cancelling credits the customer", () => {
  const order = createOrder("cust-1", [smallParcel()], "10115");
  cancelOrder(order);
  assert.equal(order.status, "cancelled");
  assert.equal(balanceFor("cust-1"), -order.totalCents);
});
