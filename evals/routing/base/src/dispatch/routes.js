const ROUTE_BY_ZONE = {
  A: "city-loop",
  B: "north-ring",
  C: "south-ring",
  D: "long-haul",
};

export function routeForZone(zone) {
  return ROUTE_BY_ZONE[zone];
}

export function groupByRoute(orders) {
  const groups = new Map();
  for (const order of orders) {
    const route = routeForZone(order.zone);
    groups.set(route, [...(groups.get(route) ?? []), order]);
  }
  return groups;
}
