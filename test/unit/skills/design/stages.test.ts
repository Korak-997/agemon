import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVendoredSkillPath } from "../../../../src/core/package-assets.js";

const designSkillDirectory = resolveVendoredSkillPath(
  "design",
  "agemon-design",
);

function stage(name: string): string {
  return readFileSync(
    join(designSkillDirectory, "references", `stage-${name}.md`),
    "utf8",
  );
}

describe("agemon-design stage files", () => {
  it.each([
    ["intake", ".design/brief.md"],
    ["assets", ".design/assets.md"],
    ["directions", ".design/directions.json"],
    ["build", "tokens in the repo's own system"],
    ["verify", "`not-verified`"],
    ["critique", ".design/critique-<n>.md"],
  ])(
    "the %s stage states its needs, work and gate artifact",
    (name, artifact) => {
      const contents = stage(name);

      expect(contents).toContain("## Needs");
      expect(contents).toContain("## Does");
      const gate = contents.split("## Produces")[1];
      expect(gate).toContain(artifact);
    },
  );

  it("never stops intake in a non-interactive run", () => {
    const intake = stage("intake");

    expect(intake).toContain(
      "**Never stop in a non-interactive run: proceed and log assumptions in `.design/brief.md`.**",
    );
    expect(intake).toContain("decide for me");
    expect(intake).toContain("I read this as");
  });

  it("keeps the build to real material and one direction", () => {
    const build = stage("build");

    for (const phrase of [
      "invented metrics, testimonials or logos",
      "one direction in one agent",
      "Spend boldness in one place",
      "Persuade",
      "Operate",
      "Read",
      "Experience",
    ]) {
      expect(build).toContain(phrase);
    }
  });

  it("blocks only on objective rendered checks", () => {
    const verify = stage("verify");

    for (const blocker of [
      "contrast",
      "target size",
      "overflow",
      "console errors",
      "placeholder copy",
    ]) {
      expect(verify).toContain(blocker);
    }
    expect(verify).toContain("Aesthetics stay advisory");
  });

  it("keeps the model from picking a direction", () => {
    expect(stage("directions")).toContain("The model never picks");
  });

  it("caps critique and hides the builder's self-assessment", () => {
    const critique = stage("critique");

    expect(critique).toContain("capped at two");
    expect(critique).toContain("not the builder's self-assessment");
    expect(critique).toContain("names an element and a viewport");
  });
});

describe("agemon-design derived material", () => {
  const notice = readFileSync(join(designSkillDirectory, "NOTICE.md"), "utf8");
  const derived = notice.split("## Derived material")[1] ?? "";
  const sources = derived.split("\n").filter((line) => line.startsWith("- `"));

  it("names at least one source", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("pins every source named in the section to a 40-character commit", () => {
    for (const source of sources) {
      expect(source).toMatch(/https:\/\/\S+/u);
      expect(source).toMatch(/commit [0-9a-f]{40}\b/u);
    }
  });

  it("carries the licence text of every licence the section names", () => {
    const licenses = readFileSync(
      join(designSkillDirectory, "references", "third-party-licenses.md"),
      "utf8",
    );

    expect(licenses).toContain("Apache License");
    expect(notice).toContain("open fork");
    expect(notice).toContain("manual");
  });
});
