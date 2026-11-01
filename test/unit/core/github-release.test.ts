import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareReleaseVersions,
  downloadReleaseAsset,
  fetchLatestReleaseVersion,
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

function streamOf(chunkCount: number, chunkBytes: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return { body, pulledChunks: () => pulled };
}

describe("release downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops reading a body without content-length once it passes maxBytes", async () => {
    const { body, pulledChunks } = streamOf(10, 1024);
    vi.stubGlobal("fetch", async () => new Response(body));

    await expect(
      downloadReleaseAsset("4.8.0", "agemon.tgz", 1024),
    ).rejects.toThrow("agemon.tgz is larger than expected");
    expect(pulledChunks()).toBeLessThan(10);
  });

  it("refuses a response with no body", async () => {
    vi.stubGlobal("fetch", async () => new Response(null));

    await expect(
      downloadReleaseAsset("4.8.0", "SHA256SUMS", 1024),
    ).rejects.toThrow("downloading SHA256SUMS returned no body");
  });

  it("refuses an oversized latest-release response", async () => {
    const { body } = streamOf(2048, 1024);
    vi.stubGlobal("fetch", async () => new Response(body));

    await expect(
      fetchLatestReleaseVersion(AbortSignal.timeout(5_000)),
    ).rejects.toThrow("the latest-release response is larger than expected");
  });

  it("reads a normal latest-release response", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ tag_name: "v4.8.0" })),
    );

    await expect(
      fetchLatestReleaseVersion(AbortSignal.timeout(5_000)),
    ).resolves.toBe("4.8.0");
  });
});
