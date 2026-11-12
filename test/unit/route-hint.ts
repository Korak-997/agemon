import { expect } from "vitest";

export function expectSafeRouteHint(
  routeHint: string | undefined,
  maxLength: number,
): void {
  expect(typeof routeHint).toBe("string");
  expect(routeHint?.length).toBeGreaterThan(0);
  expect(routeHint?.length).toBeLessThanOrEqual(maxLength);
  expect(routeHint).not.toMatch(/[|\n\r]|<!--/u);
  expect(routeHint).not.toMatch(/^Use when/u);
}
