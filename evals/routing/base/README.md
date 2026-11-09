# Depotline

Parcel depot back office: quotes, orders, van dispatch, tracking, returns and billing. No
dependencies. Run the tests with `npm test`.

## Pricing rules

- A parcel's price is its base rate, plus surcharges, minus the account discount, plus tax.
- The account discount applies to the base rate only, never to surcharges.
- Tax applies after the discount, per parcel. An invoice's tax is the sum of its parcels' tax.
- Percentages round to the nearest cent.
- All money is whole cents.
