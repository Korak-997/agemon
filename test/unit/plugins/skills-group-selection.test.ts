import { describe, expect, it } from "vitest";
import type { Context } from "../../../src/core/context.js";
import { SKILL_GROUPS } from "../../../src/plugins/skills/catalog.js";
import { resolveGroupsForFreshInstall } from "../../../src/plugins/skills/group-selection.js";

// resolveGroupsForFreshInstall only ever reads `dryRun` and `confirm` off the
// context — a minimal fake keeps these tests focused on that behavior
// instead of the full plugin lifecycle already covered in skills.test.ts.
function createFakeContext(overrides: {
  dryRun?: boolean;
  confirm: (message: string) => Promise<boolean>;
}): Context {
  return {
    dryRun: overrides.dryRun ?? false,
    confirm: overrides.confirm,
  } as unknown as Context;
}

describe("resolveGroupsForFreshInstall", () => {
  it("returns only default groups when the flag is 'none'", async () => {
    const context = createFakeContext({
      confirm: async () => {
        throw new Error("should not prompt when an explicit option is given");
      },
    });

    const groups = await resolveGroupsForFreshInstall(context, "none");

    expect(groups.map((group) => group.id)).toEqual(["essentials"]);
  });

  it("returns every group when the flag is 'all'", async () => {
    const context = createFakeContext({
      confirm: async () => {
        throw new Error("should not prompt when an explicit option is given");
      },
    });

    const groups = await resolveGroupsForFreshInstall(context, "all");

    expect(groups.map((group) => group.id).sort()).toEqual(
      SKILL_GROUPS.map((group) => group.id).sort(),
    );
  });

  it("combines an explicit comma-separated list with the defaults", async () => {
    const context = createFakeContext({
      confirm: async () => {
        throw new Error("should not prompt when an explicit option is given");
      },
    });

    const groups = await resolveGroupsForFreshInstall(
      context,
      "security, performance",
    );

    expect(groups.map((group) => group.id).sort()).toEqual(
      ["essentials", "performance", "security"].sort(),
    );
  });

  it("throws on an unknown group id", async () => {
    const context = createFakeContext({ confirm: async () => true });

    await expect(
      resolveGroupsForFreshInstall(context, "not-a-real-group"),
    ).rejects.toThrow("Unknown skill group id(s): not-a-real-group");
  });

  it("prompts once per optional group when no flag is given", async () => {
    const askedMessages: string[] = [];
    const context = createFakeContext({
      confirm: async (message) => {
        askedMessages.push(message);
        return message.includes("'Security'");
      },
    });

    const groups = await resolveGroupsForFreshInstall(context, undefined);

    const optionalGroupCount = SKILL_GROUPS.filter(
      (group) => !group.defaultSelected,
    ).length;
    expect(askedMessages.length).toBe(optionalGroupCount);
    expect(groups.map((group) => group.id).sort()).toEqual(
      ["essentials", "security"].sort(),
    );
  });

  it("skips prompting and returns only defaults during a dry run", async () => {
    const context = createFakeContext({
      dryRun: true,
      confirm: async () => {
        throw new Error("dry-run must not prompt without an explicit flag");
      },
    });

    const groups = await resolveGroupsForFreshInstall(context, undefined);

    expect(groups.map((group) => group.id)).toEqual(["essentials"]);
  });
});
