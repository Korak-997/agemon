const ZONE_BY_FIRST_DIGIT = {
  0: "A",
  1: "A",
  2: "A",
  3: "A",
  4: "B",
  5: "B",
  6: "B",
  7: "C",
  8: "C",
  9: "D",
};
const REMOTE_PREFIXES = ["18", "25", "99"];

export function zoneForPostcode(postcode) {
  const zone = ZONE_BY_FIRST_DIGIT[postcode[0]];
  if (!zone) throw new Error(`unknown postcode ${postcode}`);
  return zone;
}

export function isRemotePostcode(postcode) {
  return REMOTE_PREFIXES.some((prefix) => postcode.startsWith(prefix));
}
