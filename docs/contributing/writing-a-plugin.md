# Writing a capability plugin

agemon's work is split into **capabilities** (`crg`, `daemon`, `skills`, `agents`,
`cli-tool`, `master-prompt`). Each one is a plugin object that implements `AgemonPlugin`
from `src/plugins/types.ts`.

Plugins are built in. agemon does not load plugins from other packages; a new capability is
a pull request to this repository. Open an issue first (see [GOVERNANCE.md](../../GOVERNANCE.md)):
a capability changes what agemon does on every user's machine.

## Where a plugin runs

A normal `agemon` run goes through these steps (`src/core/orchestrator.ts`,
`src/core/consent.ts`, `src/core/apply.ts`):

1. **Plan.** Plugins run in dependency order (`dependsOn`). Each `plan(ctx, plannedSoFar)`
   returns the `ProposedOperation`s it wants: one per resource it would create, change,
   install or register. It must not change anything. `plannedSoFar` holds the operations of
   the plugins that planned before it.
2. **Consent.** Operations are grouped into consent gates (see "Operations" below), and
   the user approves or declines each gate. `--yes` approves the gates
   that allow it; a non-interactive run without `--yes` writes the plan and stops.
3. **Stage.** For approved operations, `materialize(ctx, operations)` returns the files the
   plugin will write (`StagedFile`: target path, contents, kind). agemon writes them under
   `.agemon/plans/<plan id>/staged/` and validates them before anything is touched.
4. **Apply.** agemon snapshots every target file, writes a journal, then for each capability
   with approved operations calls `apply(ctx, operations, staged)`, or, when the plugin has
   no `apply`, `detect` and then `install` if it is not present. Then it calls `verify(ctx)`.
   A thrown error or `verify` returning `ok: false` rolls back the whole run.
5. **Rollback.** Snapshots are restored, and for ledger entries this run added,
   `revert(ctx, entries)` is called on the plugin that owns them.
6. **Nuke.** `agemon nuke` previews and then calls `uninstall(ctx)` on every capability with
   ledger entries, keeping a capability while a capability that depends on it is still
   installed.

`agemon status` and `agemon inspect` call `describeState`; `verify` also runs after an apply
to check the whole result.

## The interface

As defined in `src/plugins/types.ts`:

| Member | Required | What it does |
|---|---|---|
| `id` | yes | The capability id, used in `agemon.toml`, `--only` and the ledger. |
| `dependsOn` | no | Ids of capabilities that must plan and apply first. `--only` adds them. |
| `riskClass` | no | `inert`, `writes-config`, `executes` or `credential-adjacent`; describes the plugin as a whole. Each operation carries its own `riskClass`. |
| `sharedResources` | no | Machine-wide tools the plugin installs once for every repository (see `src/core/machine-ledger.ts`). |
| `detect(ctx)` | yes | Returns `{ present, preExisting }`: is the capability already there, and was it there before agemon? |
| `desiredRevision(ctx, resourceId)` | no | The version or revision agemon wants for a resource; stored on its ledger entry. |
| `describeState(ctx)` | no | Rows for `status`/`inspect`: one per resource, with a `CapabilityState`. |
| `plan(ctx, plannedSoFar?)` | no | Proposed operations (step 1). Without it, the plugin is never part of a plan. |
| `materialize(ctx, operations)` | no | Staged files for approved operations (step 3). |
| `apply(ctx, operations, staged?)` | no | Makes the approved changes (step 4). |
| `install(ctx)` | yes | Used by apply when the plugin has no `apply`. |
| `verify(ctx)` | yes | Returns `{ ok, detail?, attention? }`. `attention` is shown and makes `status` exit 2. |
| `revert(ctx, entries)` | no | Undoes the given ledger entries during a rollback (step 5). |
| `uninstall(ctx)` | yes | Removes what the ledger says this plugin installed (step 6). |

### Operations

Build operations with `describeOperation` from `src/plugins/proposed-operation.ts`.
`gateForOperation` in `src/core/consent.ts` picks the consent gate, in this order:

- `conflict` → a decision the user must make (never answered by `--yes`);
- a `resourceId` starting with `agent-file:` → "install subagents"; one starting with
  `custom-skill-group:`, for `install-package` and `skip` → "install custom skills" (these
  prefixes belong to `agents` and `skills`);
- `skip` with `requiresConsent: true` → "install tooling"; any other `skip`, and
  `use-shared`, need no consent;
- `install-package` → "install tooling", `register-service` → "register service",
  `merge-key` → "write config", `create`/`merge-block`/`adopt`/`replace` → "touch
  instruction files".

An operation that reaches the action-based gates with `riskClass: "inert"` and
`requiresConsent: false` is refused: every change needs consent. `riskClass` does not choose
the gate; a `credential-adjacent` operation makes its gate always show the full diff, as the
"install custom skills" gate always does. `preview` is what
the user sees in the gate: a diff for file changes, a one-line note otherwise.

## Rules every plugin follows

- **Record everything you change.** Every file written, package installed or service
  registered gets a ledger entry: `ctx.manifest.recordAction({ plugin, type, target,
  preExisting, … })`. `uninstall` and `revert` work only from these entries; never from a
  guess about what is on disk. Set `preExisting: true` for anything that was there before
  agemon, so `nuke` leaves it alone.
- **Plan has no side effects.** `plan`, `detect`, `describeState` and `verify` only read.
- **Honor `ctx.dryRun`.** In a dry run, `apply`/`install`/`uninstall` describe what they
  would do and change nothing.
- **Run commands through `ctx.run(command, args, options)`.** Arguments are an array, never
  a shell string. `ctx.run` applies timeouts and output limits and lets `nuke`'s preview
  refuse commands, so `uninstall` must not call `child_process` directly.
- **Write files atomically and inside the repository** (see `src/core/files.ts`), unless the
  resource is a machine-wide shared tool.
- **Fail loudly.** Throw with a message that says what failed and what the user can do. A
  throw during apply triggers a rollback of the whole run; `revert` must be safe to call on
  entries whose change only partly happened.
- **Treat repository content as untrusted.** Files, `agemon.toml` and ledger entries can be
  edited by anyone with commit access; validate paths and names before you use them (see
  `src/core/untrusted-text.ts`).

## A minimal plugin

`src/plugins/test-plugin.ts` is the smallest valid plugin. It is registered only when
`AGEMON_DEV=1`, and its `plan` returns no operations, so it never takes part in a real run; it shows the
required members and how a plugin records and checks a ledger entry:

```ts
import type { AgemonPlugin } from "./types.js";

export const testPlugin: AgemonPlugin = {
  id: "test-plugin",
  riskClass: "inert",
  async detect(ctx) {
    return {
      present: ctx.manifest.hasActionForPlugin("test-plugin"),
      preExisting: false,
    };
  },
  async plan() {
    return [];
  },
  async install(ctx) {
    if (ctx.dryRun) {
      return;
    }
    await ctx.manifest.recordAction({
      plugin: "test-plugin",
      type: "simulated-install",
      target: "phase-1 orchestrator checkpoint",
      preExisting: false,
    });
  },
  async verify(ctx) {
    if (ctx.dryRun) {
      return { ok: true, detail: "dry-run" };
    }
    return {
      ok: ctx.manifest.hasActionForPlugin("test-plugin"),
      detail: "action logged in manifest",
    };
  },
  async uninstall() {},
};
```

A real capability returns operations from `plan`. For a complete example of plan →
materialize → apply → revert for files, read `src/plugins/agents/index.ts`; for installing
a tool, `src/plugins/cli-tool/index.ts`.

## Registering it

1. Add the plugin to `capabilityRegistry` in `src/plugins/index.ts`. The order there is the
   default order; `dependsOn` overrides it.
2. A repository whose `agemon.toml` lists `capabilities` explicitly never gets a new id on
   its own. If existing repositories should get the capability, add its id to
   `AUTO_ADDED_TO_EXISTING_CONFIGS` in `src/core/capability-migration.ts` (the `agents`
   capability is the example).
3. Document it in the README ("What It Does") and in `docs/architecture-and-operations.md`.

## Tests

Add `test/unit/plugins/<id>.test.ts`, modelled on the existing plugin tests: they build a
`Context` with fake commands (`src/core/fake-subprocess.ts`, used by
`test/unit/plugins/cli-tool.test.ts`) and a fake service manager
(`test/unit/plugins/agents.test.ts`), so nothing touches the real machine. Cover at least:

- `plan` on a clean repository and on one where the capability is already present;
- `apply` followed by `verify`;
- a failure in the middle of `apply` that leaves nothing behind after rollback (`revert`);
- `uninstall` after `apply`, and `uninstall` with `preExisting` entries that must be kept.

Then run the full check from [CONTRIBUTING.md](../../CONTRIBUTING.md), including the sandbox
roundtrip, which applies and nukes in an isolated copy:

```bash
npm run sandbox -- roundtrip clean-repo
```
