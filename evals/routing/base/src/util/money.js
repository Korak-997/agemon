export function percentOf(cents, percent) {
  return Math.round((cents * percent) / 100);
}

export function sumCents(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function formatCents(cents) {
  return `${(cents / 100).toFixed(2)} EUR`;
}
