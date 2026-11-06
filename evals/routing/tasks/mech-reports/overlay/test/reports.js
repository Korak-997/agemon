import assert from "node:assert/strict";
import { test } from "node:test";
import { toCsv } from "../src/reports/csv.js";
import { buildDailyReport } from "../src/reports/index.js";
import { overdueOrders } from "../src/reports/overdue.js";
import { returnRateByTier } from "../src/reports/returns.js";
import { revenueByZone } from "../src/reports/revenue.js";
import { vanUtilisation } from "../src/reports/van-load.js";

const NOW = new Date("2026-03-20T12:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000);
const order = (id, zone, status, totalCents, createdDaysAgo = 0, tier = "standard") => ({
  id,
  zone,
  status,
  totalCents,
  tier,
  createdAt: daysAgo(createdDaysAgo),
});

const ORDERS = [
  order("o1", "B", "created", 1000, 10, "gold"),
  order("o2", "A", "dispatched", 2000, 4),
  order("o3", "A", "delivered", 3000, 2, "gold"),
  order("o4", "B", "cancelled", 9000, 30),
  order("o5", "C", "lost", 9000, 30),
  order("o6", "A", "returned", 500, 1, "gold"),
  order("o7", "A", "dispatched", 700, 5),
];
const SLA = { A: 2, B: 3, C: 5 };

test("toCsv quotes only the fields that need it", () => {
  const csv = toCsv(
    [
      { key: "a", header: "Plain" },
      { key: "b", header: "Has, comma" },
    ],
    [
      { a: 'say "hi"', b: "x,y" },
      { a: null, b: "line\nbreak" },
      { a: 0 },
    ],
  );
  assert.equal(
    csv,
    'Plain,"Has, comma"\n"say ""hi""","x,y"\n,"line\nbreak"\n0,',
  );
});

test("revenueByZone skips cancelled and lost orders and sorts by zone", () => {
  assert.deepEqual(revenueByZone(ORDERS), [
    { zone: "A", orderCount: 4, totalCents: 6200 },
    { zone: "B", orderCount: 1, totalCents: 1000 },
  ]);
});

test("overdueOrders lists open orders past their SLA, latest first", () => {
  assert.deepEqual(overdueOrders(ORDERS, NOW, SLA), [
    { orderId: "o1", zone: "B", daysLate: 7 },
    { orderId: "o7", zone: "A", daysLate: 3 },
    { orderId: "o2", zone: "A", daysLate: 2 },
  ]);
});

test("overdueOrders breaks ties by order id and keeps its input unchanged", () => {
  const tied = [order("o9", "A", "created", 1, 5), order("o8", "A", "created", 1, 5)];
  const ids = overdueOrders(tied, NOW, SLA).map((entry) => entry.orderId);
  assert.deepEqual(ids, ["o8", "o9"]);
  assert.equal(tied[0].id, "o9");
});

test("vanUtilisation sorts fullest first, ties by id", () => {
  const vans = [
    { id: "v2", capacityKg: 800, loadKg: 400, orders: [{}, {}] },
    { id: "v1", capacityKg: 800, loadKg: 400, orders: [{}] },
    { id: "v3", capacityKg: 300, loadKg: 299, orders: [] },
  ];
  assert.deepEqual(vanUtilisation(vans), [
    { vanId: "v3", loadKg: 299, percentFull: 100, orderCount: 0 },
    { vanId: "v1", loadKg: 400, percentFull: 50, orderCount: 1 },
    { vanId: "v2", loadKg: 400, percentFull: 50, orderCount: 2 },
  ]);
});

test("returnRateByTier counts completed orders only", () => {
  const orders = [
    ...ORDERS,
    order("o10", "A", "delivered", 1, 1, "gold"),
    order("o11", "A", "delivered", 1, 1, "silver"),
  ];
  assert.deepEqual(returnRateByTier(orders), [
    { tier: "gold", completed: 3, returned: 1, ratePercent: 33.3 },
    { tier: "silver", completed: 1, returned: 0, ratePercent: 0 },
  ]);
});

test("buildDailyReport combines the reports", () => {
  const vans = [{ id: "v1", capacityKg: 800, loadKg: 200, orders: [] }];
  const report = buildDailyReport(ORDERS, vans, NOW, SLA);
  assert.equal(
    report.revenueCsv,
    "Zone,Orders,Total\nA,4,62.00 EUR\nB,1,10.00 EUR",
  );
  assert.equal(report.overdue.length, 3);
  assert.equal(report.vans[0].percentFull, 25);
  assert.deepEqual(report.returns, [
    { tier: "gold", completed: 2, returned: 1, ratePercent: 50 },
  ]);
});
