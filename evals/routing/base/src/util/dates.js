const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(earlier, later) {
  return Math.floor((later.getTime() - earlier.getTime()) / MILLISECONDS_PER_DAY);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * MILLISECONDS_PER_DAY);
}
