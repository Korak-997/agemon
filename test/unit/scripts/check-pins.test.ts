import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGNIX_VERSION,
  CODE_REVIEW_GRAPH_VERSION,
  ESSENTIALS_SKILLS_COMMIT,
} from "../../../src/plugins/pins.js";

const LONG_AGO = "2020-01-01T00:00:00Z";
const ESCAPE = String.fromCharCode(27);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function stubRegistries(): void {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url === "https://pypi.org/pypi/code-review-graph/json") {
      return jsonResponse({
        releases: {
          [CODE_REVIEW_GRAPH_VERSION]: [
            { upload_time_iso_8601: LONG_AGO, yanked: true },
          ],
        },
      });
    }
    if (url === "https://registry.npmjs.org/agnix") {
      const dependencies = Object.fromEntries(
        [
          `evil${ESCAPE}[31m`,
          ...Array.from({ length: 11 }, (_, i) => `d${i}`),
        ].map((name) => [name, "1.0.0"]),
      );
      return jsonResponse({
        time: { [AGNIX_VERSION]: LONG_AGO },
        versions: { [AGNIX_VERSION]: { dependencies } },
      });
    }
    if (url.includes(`/commits/${ESSENTIALS_SKILLS_COMMIT}`)) {
      return jsonResponse({
        sha: ESSENTIALS_SKILLS_COMMIT,
        commit: { committer: { date: LONG_AGO } },
      });
    }
    if (url.includes("/commits?")) {
      return jsonResponse([]);
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("check-pins", () => {
  it("prints refuse and problem lines with cleaned upstream names and exits 1", async () => {
    stubRegistries();
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.resetModules();

    await import("../../../scripts/check-pins.js");

    expect(printed).toContain(
      `problem code-review-graph (PyPI): pinned ${CODE_REVIEW_GRAPH_VERSION} is withdrawn upstream`,
    );
    const refuseLine = printed.find((line) => line.startsWith("refuse  agnix"));
    expect(refuseLine).toBe(
      `refuse  agnix (npm): pinned ${AGNIX_VERSION} declares dependencies npm would fetch unverified: evil?[31m, d0, d1, d2, d3, d4, d5, d6, d7, d8 and 2 more`,
    );
    expect(printed.join("\n")).not.toContain(ESCAPE);
    expect(process.exitCode).toBe(1);
  });
});
