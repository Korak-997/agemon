# Reports

Create these modules under `src/reports/`. Each export is pure: it never touches the order store
and never changes its arguments.

## `src/reports/csv.js`: `toCsv(columns, rows)`

- `columns` is `[{ key, header }]`. `rows` is an array of objects.
- The first line holds the headers, then one line per row. Lines join with `\n`, with no trailing
  newline.
- A field containing a comma, a double quote or a newline is wrapped in double quotes, with inner
  double quotes doubled. Headers follow the same rule.
- `null` and `undefined` become an empty field.

## `src/reports/revenue.js`: `revenueByZone(orders)`

- Ignore orders whose status is `cancelled` or `lost`.
- Return `[{ zone, orderCount, totalCents }]` sorted by zone, one entry per zone that has orders.

## `src/reports/overdue.js`: `overdueOrders(orders, now, slaDaysByZone)`

- Consider only orders whose status is `created` or `dispatched`.
- An order is overdue when `daysBetween(createdAt, now)` is greater than its zone's SLA. Use
  `daysBetween` from `src/util/dates.js`.
- Return `[{ orderId, zone, daysLate }]`, where `daysLate` is the days past the SLA, largest
  `daysLate` first, ties by `orderId` ascending.

## `src/reports/van-load.js`: `vanUtilisation(vans)`

- Return `[{ vanId, loadKg, percentFull, orderCount }]`. `percentFull` is `loadKg` as a percentage
  of the van's `capacityKg`, rounded to the nearest whole number.
- Sort by `percentFull` descending, ties by `vanId` ascending.

## `src/reports/returns.js`: `returnRateByTier(orders)`

- Consider only orders whose status is `delivered` or `returned`.
- Return `[{ tier, completed, returned, ratePercent }]` sorted by tier, one entry per tier that has
  such orders. `completed` counts both statuses, `returned` counts only `returned`, and
  `ratePercent` is `returned / completed` as a percentage rounded to one decimal place.

## `src/reports/index.js`: `buildDailyReport(orders, vans, now, slaDaysByZone)`

Return `{ revenueCsv, overdue, vans, returns }`:

- `revenueCsv` is `toCsv` of `revenueByZone(orders)` with columns `Zone`, `Orders`, `Total`, where
  `Total` is the row's `totalCents` passed through `formatCents` from `src/util/money.js`.
- `overdue`, `vans` and `returns` are the results of the other three reports.
