let lastId = 0;

export function nextId(prefix) {
  lastId += 1;
  return `${prefix}-${String(lastId).padStart(6, "0")}`;
}
