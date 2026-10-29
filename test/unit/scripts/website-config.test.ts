import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const NPM_REGISTRY = "https://registry.npmjs.org/";

function repositoryFile(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

describe("website configuration", () => {
  it("uses one site origin in astro.config.mjs, the build script and the deploy workflow", () => {
    const astroOrigin = /site: "([^"]+)"/u.exec(
      repositoryFile("website/astro.config.mjs"),
    )?.[1];
    const workflowOrigin = parse(
      repositoryFile(".github/workflows/website.yml"),
    ).env.SITE_ORIGIN;
    const buildScriptOrigin = /^SITE_ORIGIN="([^"]+)"$/mu.exec(
      repositoryFile("scripts/build-website.sh"),
    )?.[1];

    expect(astroOrigin).toMatch(/^https:\/\/[a-z0-9.-]+$/u);
    expect(workflowOrigin).toBe(astroOrigin);
    expect(buildScriptOrigin).toBe(astroOrigin);
  });

  it("registers the Starlight link validator", () => {
    const astroConfig = repositoryFile("website/astro.config.mjs");

    expect(astroConfig).toMatch(
      /^import starlightLinksValidator from "starlight-links-validator";$/mu,
    );
    expect(astroConfig).toMatch(/plugins: \[starlightLinksValidator\(\)\]/u);
  });

  it("installs every website dependency from the npm registry with an integrity hash", () => {
    const lockfile = JSON.parse(
      repositoryFile("website/package-lock.json"),
    ) as {
      packages: Record<
        string,
        { resolved?: string; integrity?: string; link?: boolean }
      >;
    };
    const unverified = Object.entries(lockfile.packages)
      .filter(([path, entry]) => path !== "" && !entry.link)
      .filter(
        ([, entry]) =>
          !entry.resolved?.startsWith(NPM_REGISTRY) ||
          !entry.integrity?.startsWith("sha512-"),
      )
      .map(([path]) => path);

    expect(unverified).toEqual([]);
  });
});
