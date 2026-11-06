# Agent matrix

What agemon's skill install reaches on each agent, recorded on 2026-11-06. Gaps stay visible.

Each cell says how it is known:

- **run**: seen on this date, on the version named.
- **docs**: the vendor's page says so; nobody ran it for this table.
- **unknown**: not checked, or the vendor's page does not say.

Only Claude Code, Cursor and Antigravity were on the test machine. Cursor and Antigravity are
editors, and nothing here drives their agents from a script, so their rows have no agent results.

## Reach

| Agent | Folder agemon uses | Files written | Listed | Invoked by name | Auto-trigger | Subagents | Browser |
|---|---|---|---|---|---|---|---|
| Claude Code 2.1.318 | `.claude/skills` | **run** | **run**: listed once; ignores `.agents/skills` | **run**, asked in plain words; **docs**: `/name` | **run**: see below | **docs**: yes | unknown |
| Cursor 3.22.12 | `.claude/skills`, and `.agents/skills` if a copy exists | **run** | unknown | **docs**: `/name` | unknown | unknown | unknown |
| Antigravity 1.107.0 | `.agents/skills` | **run** | unknown | **docs**: `/name` | unknown | unknown | unknown |
| Codex | `.agents/skills` | **run**, by repository marker; Codex itself not run | unknown | **docs**: `$name` | unknown | unknown | unknown |
| Gemini CLI | `.agents/skills` | **run**, by repository marker; Gemini CLI itself not run | unknown | unknown: docs show the `activate_skill` tool and `/skills list`, not a by-name syntax | unknown | unknown | unknown |
| Copilot | `.claude/skills`, and `.agents/skills` if a copy exists | **run** | unknown | unknown | unknown | unknown | unknown |
| OpenCode | `.claude/skills`, and `.agents/skills` if a copy exists | **run** | unknown | unknown: docs describe a `skill` tool | unknown | unknown | unknown |
| Devin Desktop | `.agents/skills` | **run**, by repository marker; Devin itself not run | unknown | **docs**: `/name` | unknown | unknown | unknown |

"Files written" means agemon put the skill in a folder that agent's docs say it reads. It does not
mean the agent loaded it.

**Auto-trigger, Claude Code only.** claude-opus-5-5 on CLI 2.1.318, one run per case per arm: 5/5
clear requests, 2/2 small edits, and 4/4 near-misses correctly not triggered, with and without the
project pointer. These are rough counts on few runs. See [README.md](README.md#recorded-results).

## When agemon writes `.agents/skills`

`.claude/skills` is always the primary install. agemon offers copies in `.agents/skills`, behind
consent, only when it finds an agent whose docs list no `.claude/skills` path: Codex, Gemini CLI,
Antigravity or Devin. It looks for the executable on `PATH` without running it (`codex`, `gemini`,
`antigravity`, `agy`, `devin`) and for a repository folder (`.codex`, `.gemini`, `.devin`).

## Duplicates

**Not settled for Cursor, Copilot or OpenCode.** All three read both folders, so a repository with
copies in both may list a skill twice. Nobody ran that check:

- OpenCode's troubleshooting page says to "ensure skill names are unique across all locations".
- Codex's page says that when two skills share a name "both can appear in skill selectors".
- Cursor's and Copilot's pages do not say.

agemon cannot avoid both folders when Claude Code and, for example, Codex share a repository. It
only limits the overlap, by not writing `.agents/skills` unless an agent needs it.

## Frontmatter

The `.agents/skills` copy moves keys the [Agent Skills standard](https://agentskills.io/specification)
does not define into `metadata`, as strings. `name` and `description` do not change.

- **Codex:** the `quick_validate.py` script in its bundled `skill-creator` rejects any key outside
  `name`, `description`, `license`, `allowed-tools` and `metadata`. That is confirmed at the
  repository's `main` on 2026-11-06. Whether Codex's own loader also rejects them is **unknown**,
  because its source could not be reached.
- **Devin:** it gives `triggers` its own meaning (`user`, `model`), so agemon's list of phrases
  would be misread. It stays only in the `.claude/skills` copy's frontmatter.
- **OpenCode:** ignores unknown fields.

## `disable-model-invocation`

This flag is not universal, so **agemon does not copy a skill that sets it to `.agents/skills`**.
Today that is `agemon-adhd`, which changes every later response and must run only when named.

| Agent | Run-by-name-only control | Source |
|---|---|---|
| Claude Code | `disable-model-invocation: true` | **docs** |
| Cursor | `disable-model-invocation: true`, but [reported ignored in `.agents/skills`](https://forum.cursor.com/t/disable-model-invocation-true-ignored-in-agents-skills/166846) on 3.12.17 | **docs**, user report |
| Codex | `policy.allow_implicit_invocation: false` in `agents/openai.yaml` | **docs** |
| Devin | `triggers: [user]` | **docs** |
| OpenCode | none; unknown fields are ignored | **docs** |
| Gemini CLI, Antigravity, Copilot | unknown; the pages read do not mention the flag | unknown |

## Sources

Read on 2026-11-06:
[Codex](https://developers.openai.com/codex/skills),
[Cursor](https://cursor.com/docs/skills.md),
[Gemini CLI](https://geminicli.com/docs/cli/skills.md),
[Antigravity](https://antigravity.google/docs/skills),
[Copilot](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills),
[OpenCode](https://opencode.ai/docs/skills/),
[Devin CLI](https://docs.devin.ai/cli/extensibility/skills/overview.md),
[Devin Desktop](https://docs.devin.ai/desktop/devin-local/customizations.md).

## `skills` CLI pin

Reviewed 1.7.2 against 1.7.6 by reading the diff, without running 1.7.6. The pin stays at 1.7.2.
Single-agent installs still resolve to copy mode. The changes are symlink handling while copying,
a dry-run message, global-directory handling, and new or moved agent targets. None is needed here,
so a bump should be its own change, re-run against the install tests.
