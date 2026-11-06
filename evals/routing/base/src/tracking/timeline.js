import { eventsFor } from "./events.js";

const LABEL_BY_KIND = {
  dispatched: "On the van",
  delivered: "Delivered",
  returned: "Returned to depot",
};

export function timelineFor(orderId) {
  return eventsFor(orderId)
    .toSorted((first, second) => first.at - second.at)
    .map((event) => ({
      label: LABEL_BY_KIND[event.kind] ?? event.kind,
      at: event.at,
    }));
}
