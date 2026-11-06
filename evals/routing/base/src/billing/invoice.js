import { sumCents } from "../util/money.js";
import { postEntry } from "./ledger.js";

export function invoiceFor(order) {
  const quotes = order.parcels.map((parcel) => parcel.quote);
  return {
    orderId: order.id,
    billedTo: order.customerRef,
    netCents: sumCents(quotes.map((quote) => quote.netCents)),
    taxCents: sumCents(quotes.map((quote) => quote.taxCents)),
    totalCents: sumCents(quotes.map((quote) => quote.totalCents)),
  };
}

export function postInvoice(order) {
  const invoice = invoiceFor(order);
  postEntry(order.customerRef, invoice.totalCents, `invoice for ${order.id}`);
  return invoice;
}
