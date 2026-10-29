import { afterEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => ({
  multiselect: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  multiselect: clack.multiselect,
  select: vi.fn(),
  cancel: clack.cancel,
  isCancel: (value: unknown) => typeof value === "symbol",
}));

import type { Context } from "../../../src/core/context.js";
import {
  buildCustomSkillGroups,
  findSkillGroup,
  SKILL_GROUPS,
  type SkillGroup,
} from "../../../src/plugins/skills/catalog.js";
import {
  selectGroupsForFreshInstall,
  selectNewlyOfferedGroups,
} from "../../../src/plugins/skills/group-selection.js";

function createFakeContext(overrides: {
  dryRun?: boolean;
  yes?: boolean;
  interactive?: boolean;
  skillGroupsOption?: string;
}): Context {
  return {
    dryRun: overrides.dryRun ?? false,
    yes: overrides.yes ?? false,
    interactive: overrides.interactive ?? false,
    skillGroupsOption: overrides.skillGroupsOption,
  } as unknown as Context;
}

const [HOUSE_STYLE] = buildCustomSkillGroups([
  {
    id: "house-style",
    label: "House style",
    skills: [
      {
        kind: "local",
        path: "./tools/skills/house-rules",
        skillName: "house-rules",
      },
    ],
  },
]);

function ids(groups: SkillGroup[]): string[] {
  return groups.map((group) => group.id).sort();
}

async function resolveGroupsForFreshInstall(
  ctx: Context,
  skillGroupsOption: string | undefined,
): Promise<SkillGroup[]> {
  return (
    await selectGroupsForFreshInstall(
      { ...ctx, skillGroupsOption } as Context,
      [],
    )
  ).chosen;
}

const optionalGroupIds = SKILL_GROUPS.filter(
  (group) => !group.defaultSelected,
).map((group) => group.id);

afterEach(() => {
  vi.restoreAllMocks();
  clack.multiselect.mockReset();
  clack.cancel.mockReset();
});

describe("selectGroupsForFreshInstall", () => {
  it("returns only default groups when the flag is 'none'", async () => {
    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({}),
      "none",
    );

    expect(groups.map((group) => group.id)).toEqual(["essentials"]);
  });

  it("returns every group when the flag is 'all'", async () => {
    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({}),
      "all",
    );

    expect(groups.map((group) => group.id).sort()).toEqual(
      SKILL_GROUPS.map((group) => group.id).sort(),
    );
  });

  it("combines an explicit comma-separated list with the defaults", async () => {
    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({}),
      "security, performance",
    );

    expect(groups.map((group) => group.id).sort()).toEqual(
      ["essentials", "performance", "security"].sort(),
    );
  });

  it("throws on an unknown group id", async () => {
    await expect(
      resolveGroupsForFreshInstall(createFakeContext({}), "not-a-real-group"),
    ).rejects.toThrow("Unknown skill group id(s): not-a-real-group");
  });

  it("shows one multiselect over the optional groups and returns the picked set", async () => {
    clack.multiselect.mockResolvedValueOnce(["security"]);

    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({ interactive: true }),
      undefined,
    );

    expect(clack.multiselect).toHaveBeenCalledTimes(1);
    const offeredValues = clack.multiselect.mock.calls[0][0].options.map(
      (option: { value: string }) => option.value,
    );
    expect(offeredValues).toEqual(optionalGroupIds);
    expect(groups.map((group) => group.id).sort()).toEqual(
      ["essentials", "security"].sort(),
    );
  });

  it("cancels and exits 130 when the multiselect is aborted", async () => {
    clack.multiselect.mockResolvedValueOnce(Symbol("cancel"));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await resolveGroupsForFreshInstall(
      createFakeContext({ interactive: true }),
      undefined,
    ).catch(() => {});

    expect(clack.cancel).toHaveBeenCalledWith("Cancelled — nothing applied.");
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("installs every group under --yes without prompting", async () => {
    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({ yes: true, interactive: true }),
      undefined,
    );

    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(groups.map((group) => group.id).sort()).toEqual(
      SKILL_GROUPS.map((group) => group.id).sort(),
    );
  });

  it("returns only defaults in a non-interactive session", async () => {
    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({ interactive: false }),
      undefined,
    );

    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(groups.map((group) => group.id)).toEqual(["essentials"]);
  });

  it("skips prompting and returns only defaults during a dry run", async () => {
    const groups = await resolveGroupsForFreshInstall(
      createFakeContext({ dryRun: true, interactive: true }),
      undefined,
    );

    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(groups.map((group) => group.id)).toEqual(["essentials"]);
  });
});

describe("custom skill groups (D12-1)", () => {
  it("are never chosen by --yes or 'all'", async () => {
    for (const ctx of [
      createFakeContext({ yes: true, interactive: true }),
      createFakeContext({ skillGroupsOption: "all" }),
    ]) {
      const selection = await selectGroupsForFreshInstall(ctx, [HOUSE_STYLE]);
      expect(ids(selection.chosen)).not.toContain("house-style");
      expect(ids(selection.offered)).not.toContain("house-style");
    }
  });

  it("are chosen when named in the skill groups option", async () => {
    const selection = await selectGroupsForFreshInstall(
      createFakeContext({ skillGroupsOption: "house-style" }),
      [HOUSE_STYLE],
    );

    expect(ids(selection.chosen)).toEqual(["essentials", "house-style"]);
  });

  it("appear in the interactive multiselect next to the optional groups", async () => {
    clack.multiselect.mockResolvedValueOnce([]);

    const selection = await selectGroupsForFreshInstall(
      createFakeContext({ interactive: true }),
      [HOUSE_STYLE],
    );

    const offeredValues = clack.multiselect.mock.calls[0][0].options.map(
      (option: { value: string }) => option.value,
    );
    expect(offeredValues).toEqual([...optionalGroupIds, "house-style"]);
    expect(ids(selection.offered)).toContain("house-style");
  });
});

describe("selectNewlyOfferedGroups", () => {
  const design = findSkillGroup("design") as SkillGroup;

  it("offers nothing and declines nothing in a non-interactive run without --yes", async () => {
    const selection = await selectNewlyOfferedGroups(
      createFakeContext({}),
      [],
      [design],
    );

    expect(selection).toEqual({ chosen: [], offered: [] });
  });

  it("records new built-in groups as offered under non-interactive --yes, but leaves custom groups pending", async () => {
    const selection = await selectNewlyOfferedGroups(
      createFakeContext({ yes: true }),
      [HOUSE_STYLE],
      [design, HOUSE_STYLE],
    );

    expect(selection).toEqual({ chosen: [], offered: [design] });
  });

  it("chooses an unoffered group that the skill groups option names, even without a terminal", async () => {
    const selection = await selectNewlyOfferedGroups(
      createFakeContext({ skillGroupsOption: "essentials,house-style" }),
      [HOUSE_STYLE],
      [design, HOUSE_STYLE],
    );

    expect(ids(selection.chosen)).toEqual(["house-style"]);
    expect(selection.offered).toEqual([]);
  });

  it("asks about the remaining groups and reports them as offered", async () => {
    clack.multiselect.mockResolvedValueOnce(["design"]);

    const selection = await selectNewlyOfferedGroups(
      createFakeContext({ interactive: true }),
      [HOUSE_STYLE],
      [design, HOUSE_STYLE],
    );

    expect(ids(selection.chosen)).toEqual(["design"]);
    expect(ids(selection.offered)).toEqual(["design", "house-style"]);
  });
});
