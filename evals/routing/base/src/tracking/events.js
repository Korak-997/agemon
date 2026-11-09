const eventsByOrder = new Map();

export function recordEvent(orderId, kind, at = new Date()) {
  const event = { orderId, kind, at };
  eventsByOrder.set(orderId, [...eventsFor(orderId), event]);
  return event;
}

export function eventsFor(orderId) {
  return eventsByOrder.get(orderId) ?? [];
}

export function clearEvents() {
  eventsByOrder.clear();
}
