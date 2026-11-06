const ordersById = new Map();

export function saveOrder(order) {
  ordersById.set(order.id, order);
  return order;
}

export function getOrder(orderId) {
  return ordersById.get(orderId);
}

export function allOrders() {
  return [...ordersById.values()];
}

export function ordersForCustomer(customerRef) {
  return allOrders().filter((order) => order.customerRef === customerRef);
}

export function clearOrders() {
  ordersById.clear();
}
