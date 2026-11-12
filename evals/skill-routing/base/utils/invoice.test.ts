import { describe, expect, it } from "vitest";
import { invoiceTotalCents, lineTotalCents } from "./invoice";

describe("invoice totals", () => {
  it("adds VAT to a line", () => {
    expect(
      lineTotalCents({ description: "Hosting", unitPriceCents: 1000, quantity: 1 }),
    ).toBe(1190);
  });

  it("sums the lines", () => {
    expect(
      invoiceTotalCents([
        { description: "Hosting", unitPriceCents: 1000, quantity: 2 },
        { description: "Domain", unitPriceCents: 500, quantity: 1 },
      ]),
    ).toBe(2975);
  });
});
