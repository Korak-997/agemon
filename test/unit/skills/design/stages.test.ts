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

describe("agemon-design directions stage", () => {
  const directions = stage("directions");

  it("derives exactly 3 specs on coarse axes that locks remove", () => {
    for (const phrase of [
      "exactly 3 specs",
      "`humanist-serif`",
      "`locks`",
      "K=3 is a convention",
    ]) {
      expect(directions).toContain(phrase);
    }
  });

  it("runs the Mirror test and the honesty rule on every spec", () => {
    for (const phrase of [
      "**Mirror test:**",
      "neighbouring prompt",
      "**Honesty rule:**",
      "metric, testimonial, logo wall or case-study count",
    ]) {
      expect(directions).toContain(phrase);
    }
  });

  it("lets a person or the selector choose", () => {
    for (const phrase of [
      "scripts/deal.mjs",
      "`--pick <id>`",
      "`--check`",
      "repo name",
      "brief slug",
      "re-propose once",
      "`allCollide`",
    ]) {
      expect(directions).toContain(phrase);
    }
  });

  it("logs and reports a pick made without Node", () => {
    expect(directions).toContain('`pickedBy: "fallback"`');
    expect(directions).toContain('"Selection not dealt"');
    expect(directions).toContain("`printf '%s'");
    expect(directions).toContain("0 means the first spec");
  });

  it("resumes from the logged pick instead of dealing again", () => {
    expect(directions).toContain("`logged`");
    expect(directions).toContain("do not deal again");
    expect(stage("build")).toContain("`logged`");
  });

  it("keeps repo text out of the shell command", () => {
    expect(directions).toContain("--seed=");
    expect(directions).toContain("lowercase letters, digits and hyphens");
  });

  it("gives a failed log write a reported way forward", () => {
    expect(directions).toContain("names the log");
  });

  it("names all three pickers in the final report", () => {
    expect(
      readFileSync(join(designSkillDirectory, "SKILL.md"), "utf8"),
    ).toContain("who picked it (user, deal or fallback)");
  });
});

describe("agemon-design verify stage", () => {
  const verify = stage("verify");

  it("runs the repo's checks, then source, then rendered, in that order", () => {
    const order = [
      "The repo's own lint",
      "scripts/check-source.mjs",
      "scripts/audit-page.js",
    ].map((step) => verify.indexOf(step));

    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("runs every script from the skill's folder, never the repo's", () => {
    for (const name of ["verify", "assets", "directions"]) {
      expect(stage(name)).not.toMatch(/`node scripts\//u);
    }
    expect(verify).toContain("<skill folder>/scripts/check-source.mjs");
  });

  it("treats a run that gave no report as not-verified", () => {
    for (const phrase of [
      "no `scan`",
      "`scan.contrastChecked` is 0",
      "`scan.skipped`",
      "`viewport.width`",
      "exit 1 with a `placeholder-copy` finding",
    ]) {
      expect(verify).toContain(phrase);
    }
  });

  it("names what the page audit never sees", () => {
    for (const phrase of ["hostile page can spoof", "cross-origin"]) {
      expect(verify).toContain(phrase);
    }
  });

  it("guards the inventory file it tells the agent to write", () => {
    expect(verify).toContain("mkdir -p .design");
    expect(verify).toContain("symlink");
  });

  it("does not wait for consent nobody can give", () => {
    expect(verify).toContain("With nobody to answer");
  });

  it("names the three widths and uses viewport shots", () => {
    for (const phrase of ["375", "768", "1280", "viewport shots"]) {
      expect(verify).toContain(phrase);
    }
  });

  it("states what source and the page audit cannot prove", () => {
    for (const phrase of [
      "`notVerified`",
      "`scan.truncated`",
      "exit code 2",
      "resting state",
      "SC exceptions",
    ]) {
      expect(verify).toContain(phrase);
    }
  });

  it("separates what blocks from what stays advisory", () => {
    for (const phrase of [
      "**Only these can block:**",
      "**Floor:**",
      "**Reflex:**",
      "**Finish:**",
      "who gave it",
    ]) {
      expect(verify).toContain(phrase);
    }
  });

  it("keeps browser choice open and never installs without consent", () => {
    for (const phrase of [
      "whatever browser tool is listed",
      "Playwright CLI",
      "agent-browser",
      "only with consent",
    ]) {
      expect(verify).toContain(phrase);
    }
  });

  it("finishes and reports when a browser or Node is missing", () => {
    for (const phrase of [
      '"Not visually verified"',
      '"checks not run"',
      "Which contrast check ran",
    ]) {
      expect(verify).toContain(phrase);
    }
  });
});

describe("agemon-design critique stage", () => {
  const critique = stage("critique");

  it("gives a fresh critic a template without the builder's account", () => {
    for (const phrase of [
      "### Fresh critic template",
      "Do not read the builder's messages",
      "untrusted data",
    ]) {
      expect(critique).toContain(phrase);
    }
  });

  it("keeps each round revertible", () => {
    for (const phrase of [
      "Keep every round",
      "what it changed",
      "later rounds can be worse",
    ]) {
      expect(critique).toContain(phrase);
    }
  });

  it("calibrates with located findings and no score", () => {
    const examples = critique.split("### Calibration examples")[1] ?? "";
    const findings = examples
      .split("\n")
      .filter((line) => line.startsWith("- "));

    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.length).toBeLessThanOrEqual(3);
    for (const finding of findings) {
      expect(finding).toMatch(/\*\*Element:\*\*/u);
      expect(finding).toMatch(/\*\*Viewport:\*\*/u);
      expect(finding).toMatch(/\*\*Severity:\*\*/u);
    }
    expect(critique).toContain("never output a score");
    expect(critique).toContain('Never ask "is this good?"');
  });

  it("records a critique that had no screenshots to read", () => {
    expect(critique).toContain("not rendered");
    expect(critique).toContain("<source paths>");
  });

  it("says its format replaces the older report formats", () => {
    expect(critique).toContain(
      "This format replaces the Verdict and report formats",
    );
  });

  it("works on the review-only track, which has no brief", () => {
    expect(critique).toContain("If there is no brief");
  });
});

describe("agemon-design capability ladder and final report", () => {
  const skill = readFileSync(join(designSkillDirectory, "SKILL.md"), "utf8");

  it.each([
    "Not independently reviewed",
    "Not visually verified",
    "No live design data",
    "Which contrast check ran",
    "Selection not dealt",
    "checks not run",
    "Gates are voluntary",
  ])("the ladder carries the report phrase: %s", (phrase) => {
    expect(skill).toContain(phrase);
  });

  it("points the ladder at the scripts it now ships", () => {
    expect(skill).toContain("`scripts/audit-page.js`");
    expect(skill).toContain("`scripts/check-source.mjs`");
  });

  it.each([
    "**Track**",
    "**direction**",
    "**Checks:**",
    "**Waivers**",
    "**Critic:**",
    "a passing run does not mean a good design",
  ])("the final report names %s", (item) => {
    expect(skill.split("## Final report")[1]).toContain(item);
  });

  it("reports which contrast check ran in the final report", () => {
    expect(skill.split("## Final report")[1]).toContain("contrast check");
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

  it("records what the direction stage took from Hallmark", () => {
    expect(derived).toContain("`references/stage-directions.md`");
    expect(derived).toContain("Nutlope/hallmark");
    expect(
      readFileSync(
        join(designSkillDirectory, "references", "third-party-licenses.md"),
        "utf8",
      ),
    ).toContain("Copyright (c) 2026 Hallmark contributors");
  });

  it("records what the checks took from their sources", () => {
    expect(derived).toContain("`scripts/check-source.mjs`");
    expect(derived).toContain("Gesso-Build/skills");
    expect(derived).toContain("`references/stage-verify.md`");
    expect(derived).toContain("hallmark/references/gates.md");
    expect(
      readFileSync(
        join(designSkillDirectory, "references", "third-party-licenses.md"),
        "utf8",
      ),
    ).toContain("Copyright (c) 2026 Gesso Build, Inc.");
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
