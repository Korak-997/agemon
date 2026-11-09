import { sumCents } from "../util/money.js";

let entries = [];

export function postEntry(customerRef, cents, reason) {
  const entry = { customerRef, cents, reason };
  entries.push(entry);
  return entry;
}

export function balanceFor(customerRef) {
  return sumCents(
    entries
      .filter((entry) => entry.customerRef === customerRef)
      .map((entry) => entry.cents),
  );
}

export function clearLedger() {
  entries = [];
}
