const TEMPLATE_BY_STATUS = {
  dispatched: (order) => `Order ${order.id} is on its way.`,
  delivered: (order) => `Order ${order.id} was delivered.`,
};

export function notificationFor(order) {
  const template = TEMPLATE_BY_STATUS[order.status];
  if (!template) return null;
  return { recipient: order.customerRef, body: template(order) };
}
