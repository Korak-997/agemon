Customers are becoming accounts. Make this change everywhere under `src/`:

1. Rename the `customerRef` field and every parameter or variable of that name to `accountId`. This
   includes order objects, ledger entries and credit notes.
2. Rename `ordersForCustomer` to `ordersForAccount`.
3. In manifest lines, rename the `customer` key to `account`.
4. Change `createOrder(customerRef, parcels, postcode, tier = "standard")` to take one object:
   `createOrder({ accountId, parcels, postcode, tier = "standard" })`.

Nothing else changes: `billedTo` on invoices and `recipient` on notifications keep their names. The
tests in `test/` already describe the new shape and must all pass (`npm test`). Do not change any
test.
