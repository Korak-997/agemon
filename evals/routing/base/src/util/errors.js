export class DepotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function invalidOrder(message) {
  return new DepotError("invalid-order", message);
}

export function invalidTransition(from, to) {
  return new DepotError("invalid-transition", `cannot move from ${from} to ${to}`);
}
