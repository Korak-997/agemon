import { taxOn } from "../pricing/tax.js";
import { sumCents } from "../util/money.js";
import { postEntry } from "./ledger.js";

export function invoiceFor(order) {
  const quotes = order.parcels.map((parcel) => parcel.quote);
  const grossBeforeDiscount = sumCents(
    quotes.map((quote) => quote.baseCents + quote.surchargeCents),
  );
  const netCents = sumCents(quotes.map((quote) => quote.netCents));
  const taxCents = taxOn(grossBeforeDiscount);
  return {
    orderId: order.id,
    billedTo: order.customerRef,
    netCents,
    taxCents,
    totalCents: netCents + taxCents,
  };
}

export function postInvoice(order) {
  const invoice = invoiceFor(order);
  postEntry(order.customerRef, invoice.totalCents, `invoice for ${order.id}`);
  return invoice;
}
