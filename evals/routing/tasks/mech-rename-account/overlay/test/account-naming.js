import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { invoiceFor } from "../src/billing/invoice.js";
import { balanceFor, postEntry } from "../src/billing/ledger.js";
import { createOrder } from "../src/orders/create.js";
import { smallParcel } from "./helpers.js";

test("the old names are gone from src", () => {
  const files = readdirSync("src", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /customerRef|ordersForCustomer/, file);
  }
});

test("orders carry accountId and invoices keep billedTo", () => {
  const order = createOrder({
    accountId: "acct-9",
    parcels: [smallParcel()],
    postcode: "10115",
    tier: "gold",
  });
  assert.equal(order.accountId, "acct-9");
  assert.equal(order.tier, "gold");
  assert.equal(invoiceFor(order).billedTo, "acct-9");
});

test("ledger entries are keyed by accountId", () => {
  const entry = postEntry("acct-8", 100, "test");
  assert.equal(entry.accountId, "acct-8");
  assert.equal(balanceFor("acct-8"), 100);
});
