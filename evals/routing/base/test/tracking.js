import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrder } from "../src/orders/create.js";
import { advanceStatus } from "../src/orders/status.js";
import { recordEvent } from "../src/tracking/events.js";
import { notificationFor } from "../src/tracking/notify.js";
import { timelineFor } from "../src/tracking/timeline.js";
import { smallParcel } from "./helpers.js";

test("the timeline is in time order with readable labels", () => {
  recordEvent("ord-t", "delivered", new Date("2026-03-02T00:00:00Z"));
  recordEvent("ord-t", "dispatched", new Date("2026-03-01T00:00:00Z"));
  assert.deepEqual(
    timelineFor("ord-t").map((entry) => entry.label),
    ["On the van", "Delivered"],
  );
});

test("a dispatched order notifies its customer", () => {
  const order = createOrder("cust-1", [smallParcel()], "10115");
  assert.equal(notificationFor(order), null);
  advanceStatus(order, "dispatched");
  assert.equal(notificationFor(order).recipient, "cust-1");
});
