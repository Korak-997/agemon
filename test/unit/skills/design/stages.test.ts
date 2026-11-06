import { readdirSync, readFileSync } from "node:fs";
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

describe("agemon-design assets stage", () => {
  const assets = stage("assets");

  it("uses the inventory and says what happens without Node", () => {
    expect(assets).toContain("scripts/inventory.mjs");
    expect(assets).toContain("`brandStatus`");
    expect(assets).toContain('"checks not run"');
    expect(assets).toContain("`scan.truncated`");
  });

  it("ranks sources strongest first, as agemon's synthesis", () => {
    const ranked = [
      "The user's instruction in this task",
      "A human-maintained contract",
      "Live build tokens",
      "Linked Figma variables",
      "Shared component code",
      "Rendered screens",
      "A brand PDF",
      "Stale configs and external scrapes",
    ].map((source) => assets.indexOf(source));

    expect(ranked).not.toContain(-1);
    expect(ranked).toEqual([...ranked].sort((a, b) => a - b));
    expect(assets).toContain("agemon's synthesis");
    expect(assets).toContain("logo use, legal marks and voice");
    expect(assets).toContain(
      "One line in the contract can override the order of ranks 3 to 8",
    );
  });

  it("reports conflicts and logs drift without fixing it", () => {
    expect(assets).toContain("one line each");
    expect(assets).toContain("Log drift; do not fix it");
  });

  it("separates brand from composition", () => {
    for (const phrase of [
      "**Fixed:**",
      "**Characteristic:**",
      "**Open:**",
      "Substitution test",
      "Brand always beats",
      "never Stripe's tokens or marks",
    ]) {
      expect(assets).toContain(phrase);
    }
  });

  it("keeps optional sources optional and bounded", () => {
    for (const phrase of [
      "never required",
      "`get_variable_defs` covers only the selection",
      "20 calls a month",
      "never `--stealth`",
      "Brandfetch data should not be saved into a repo",
    ]) {
      expect(assets).toContain(phrase);
    }
  });

  it("reads DESIGN.md tolerantly, as values only", () => {
    for (const phrase of [
      "Tolerate unknown keys",
      "Tokens override prose",
      "Do not depend on its CLI",
      "pinned version",
      "reported by file and line",
    ]) {
      expect(assets).toContain(phrase);
    }
  });
});

describe("agemon-design contract and working files", () => {
  const references = join(designSkillDirectory, "references");

  it("saves DESIGN.md only after a person approves a diff", () => {
    const build = stage("build");

    for (const phrase of [
      "`status: provisional`",
      "shown to a person as a diff",
      "`.design/DESIGN.proposed.md`",
      "reloads every session",
    ]) {
      expect(build).toContain(phrase);
    }
  });

  it("asks the final report to name content that tried to instruct", () => {
    expect(
      readFileSync(join(designSkillDirectory, "SKILL.md"), "utf8"),
    ).toContain("**Reported content:**");
  });

  it("writes new briefs and specs to .design, never .ui-craft", () => {
    const writesToOldFolder =
      /(?:write|append|create|commit|at|in)\b[^.\n]{0,30}`\.ui-craft\/(?:brief|spec)?/iu;
    const offenders = readdirSync(references).filter((file) =>
      readFileSync(join(references, file), "utf8")
        .split("\n")
        .some(
          (line) =>
            writesToOldFolder.test(line) && !/older|rewrit/iu.test(line),
        ),
    );

    expect(offenders).toEqual([]);
  });

  it("documents one brief file holding intake and durable sections", () => {
    const brief = readFileSync(join(references, "brief.md"), "utf8");

    expect(brief).toContain("`.design/brief.md`");
    expect(brief).toContain("[stage-intake.md](stage-intake.md)");
    expect(brief).toContain("Older `.ui-craft/brief.md`");
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

  it("records where the inventory's stock values come from", () => {
    expect(derived).toContain("`scripts/inventory.mjs`");
    expect(derived).toContain("shadcn-ui/ui");
    expect(derived).toContain("vercel/next.js");
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
