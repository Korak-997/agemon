import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceFor } from "../src/billing/invoice.js";
import { createOrder } from "../src/orders/create.js";
import { quoteParcel } from "../src/pricing/quote.js";

const OVERSIZED = {
  weightKg: 3,
  lengthCm: 120,
  widthCm: 60,
  heightCm: 60,
  declaredValueCents: 10000,
};
const SMALL = {
  weightKg: 1.5,
  lengthCm: 30,
  widthCm: 20,
  heightCm: 10,
  declaredValueCents: 5000,
};

test("the discount covers the base rate only and rounds to the nearest cent", () => {
  const quote = quoteParcel(OVERSIZED, "10115", "gold");
  assert.equal(quote.baseCents, 740);
  assert.equal(quote.discountCents, 89);
  assert.equal(quote.netCents, 2151);
  assert.equal(quote.taxCents, 409);
  assert.equal(quote.totalCents, 2560);
});

test("an invoice's tax and total are the sum of its parcels", () => {
  const order = createOrder("cust-1", [OVERSIZED, SMALL], "10115", "gold");
  const invoice = invoiceFor(order);
  assert.equal(invoice.netCents, 2697);
  assert.equal(invoice.taxCents, 513);
  assert.equal(invoice.totalCents, 3210);
  assert.equal(order.totalCents, invoice.totalCents);
});
