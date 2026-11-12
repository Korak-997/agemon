import { readFileSync } from "node:fs";
import { invoiceTotalCents, type LineItem } from "../../utils/invoice";

export default defineEventHandler((event) => {
  const { id } = getQuery(event);
  const lines = JSON.parse(
    readFileSync(`./data/invoices/${id}.json`, "utf8"),
  ) as LineItem[];
  return { id, totalCents: invoiceTotalCents(lines) };
});
