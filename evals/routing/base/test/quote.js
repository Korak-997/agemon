import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteParcel } from "../src/pricing/quote.js";
import { smallParcel } from "./helpers.js";

test("a plain parcel pays base rate and tax", () => {
  const quote = quoteParcel(smallParcel(), "10115", "standard");
  assert.equal(quote.baseCents, 620);
  assert.equal(quote.taxCents, 118);
  assert.equal(quote.totalCents, 738);
});

test("a remote postcode adds the remote fee", () => {
  const quote = quoteParcel(smallParcel(), "18055", "standard");
  assert.deepEqual(quote.surcharges, [{ code: "remote", cents: 900 }]);
});

test("insurance is charged on the value above the threshold", () => {
  const parcel = smallParcel({ declaredValueCents: 60000 });
  const quote = quoteParcel(parcel, "10115", "standard");
  assert.deepEqual(quote.surcharges, [{ code: "insurance", cents: 200 }]);
});
