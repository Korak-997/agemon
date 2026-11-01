import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

  it("overrides the Starlight shell components with the site's own", () => {
    const astroConfig = repositoryFile("website/astro.config.mjs");
    for (const component of [
      "Header",
      "Footer",
      "Hero",
      "PageTitle",
      "ThemeSelect",
    ]) {
      expect(astroConfig).toContain(
        `${component}: "./src/components/${component}.astro"`,
      );
    }
  });

  it("ships only the latin font files, with font-display swap", () => {
    const theme = repositoryFile("website/src/styles/theme.css");
    expect(theme).not.toMatch(/@import\s+["']@fontsource/u);
    expect(theme.match(/url\("[^"]+\.woff2"\)/gu)).toEqual([
      'url("../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2")',
      'url("../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2")',
    ]);
    expect(theme.match(/font-display: swap;/gu)).toHaveLength(2);
  });

  it("never writes raw HTML from data into a page", () => {
    const sourceFiles = readdirSync(resolve(REPOSITORY_ROOT, "website/src"), {
      recursive: true,
      encoding: "utf8",
    }).filter((path) => /\.(astro|ts|mdx)$/u.test(path));
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const path of sourceFiles) {
      expect(repositoryFile(join("website/src", path))).not.toMatch(
        /set:html|innerHTML|outerHTML|insertAdjacentHTML/u,
      );
    }
  });

  it("gives the home page one head entry, its own title", () => {
    const frontmatter = parse(
      repositoryFile("website/src/content/docs/index.mdx").split(/^---$/mu)[1],
    );
    expect(frontmatter.head).toEqual([
      { tag: "title", content: expect.any(String) },
    ]);
    expect(frontmatter.hero.actions).toBeUndefined();
  });
});
