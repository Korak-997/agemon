import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "../../../src/core/github-release.js";

describe("compareReleaseVersions", () => {
  it.each([
    ["4.8.0", "4.7.2", 1],
    ["4.7.2", "4.8.0", -1],
    ["4.10.0", "4.9.9", 1],
    ["4.8.0", "4.8.0", 0],
    ["4.8.0", "4.8.0-rc.1", 1],
    ["4.8.0-rc.1", "4.8.0", -1],
    ["4.8.0-rc.1", "4.8.0-beta.3", 1],
    ["4.8.0-beta.3", "4.8.0-alpha.9", 1],
    ["4.8.0-rc.10", "4.8.0-rc.2", 1],
    ["4.8.0-rc.1", "4.7.2", 1],
  ])("compares %s with %s as %d", (left, right, expected) => {
    expect(compareReleaseVersions(left, right)).toBe(expected);
  });
});

describe("parseReleaseVersion", () => {
  it.each([
    ["v4.8.0", "4.8.0"],
    ["4.8.0-rc.1", "4.8.0-rc.1"],
    ["4.8", undefined],
    ["4.8.0-gamma.1", undefined],
    ["4.8.0;rm", undefined],
    [42, undefined],
  ])("parses %j as %j", (input, expected) => {
    expect(parseReleaseVersion(input)).toBe(expected);
  });
});
