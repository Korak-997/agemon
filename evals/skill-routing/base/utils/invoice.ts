export interface LineItem {
  description: string;
  unitPriceCents: number;
  quantity: number;
}

export const VAT_RATE = 0.19;

export function lineTotalCents(item: LineItem): number {
  const amt = item.unitPriceCents * item.quantity;
  return Math.floor(amt * (1 + VAT_RATE));
}

export function invoiceTotalCents(lines: LineItem[]): number {
  return lines.reduce((sum, item) => sum + lineTotalCents(item), 0);
}
