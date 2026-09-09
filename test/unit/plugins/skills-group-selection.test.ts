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
import { SKILL_GROUPS } from "../../../src/plugins/skills/catalog.js";
import { resolveGroupsForFreshInstall } from "../../../src/plugins/skills/group-selection.js";

function createFakeContext(overrides: {
  dryRun?: boolean;
  yes?: boolean;
  interactive?: boolean;
}): Context {
  return {
    dryRun: overrides.dryRun ?? false,
    yes: overrides.yes ?? false,
    interactive: overrides.interactive ?? false,
  } as unknown as Context;
}

const optionalGroupIds = SKILL_GROUPS.filter(
  (group) => !group.defaultSelected,
).map((group) => group.id);

afterEach(() => {
  vi.restoreAllMocks();
  clack.multiselect.mockReset();
  clack.cancel.mockReset();
});

describe("resolveGroupsForFreshInstall", () => {
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
