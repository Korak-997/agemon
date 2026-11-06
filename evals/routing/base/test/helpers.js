export function smallParcel(overrides = {}) {
  return {
    weightKg: 2,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 10,
    declaredValueCents: 5000,
    ...overrides,
  };
}
