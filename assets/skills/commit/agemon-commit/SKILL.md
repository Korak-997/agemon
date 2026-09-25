---
name: agemon-commit
description: Use when writing a commit message or preparing a commit — staging review, message structure, splitting unrelated changes, and what belongs in the body vs. what doesn't.
---

# Agemon Commit Discipline

A compact set of rules for turning a diff into a commit. Covers what to check before staging, how to
structure the message, and when a diff should become more than one commit.

## 0. Never Commit — Hand Off the Message

- Never run `git commit` (or any command that creates a commit). Preparing the message is the job; creating
  the commit is the user's.
- Output the finished commit message and let the user run the commit themselves.
- This holds even if the user has approved commits in this session before — never assume standing
  permission to run `git commit` unless told explicitly and unambiguously that it applies going forward.

## 1. Before Staging

- Run `git status`, `git diff` (unstaged), and `git diff --cached` (staged) before deciding what goes in —
  `git diff` alone omits already-staged changes, letting them bypass review. Never stage with a blanket
  `git add -A` or `git add .` without reviewing what it picks up — untracked files may be scratch output,
  credentials, or unrelated in-progress work.
- If `git status` shows files you didn't expect to touch, find out why before including them.
- Check diff contents, not just filenames, for anything that looks like a secret (`.env` values, tokens,
  keys) even in files with innocuous names.

## 2. One Commit, One Change

- A commit should represent a single logical change. If the diff mixes an unrelated fix, a refactor, and a
  feature, split it into separate commits rather than describing all three in one message.
- Don't bundle "while I was in there" cleanup with the actual change — that belongs in its own commit, if
  it belongs at all (see agemon's Surgical Execution directive).

## 3. Message Structure

This repo enforces [Conventional Commits](https://www.conventionalcommits.org/) — via `.githooks/commit-msg`
locally and `commitlint` + PR-title linting in CI. Every subject line must use the required format, not just
as a style preference:

```
<type>[(scope)][!]: <description>
```

- Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert` (matches
  `.githooks/commit-msg`).
- Scope is optional, lowercase, and names a module/concept (`auth`, `installer`) — not a specific filename.
- Description: imperative mood ("add", "fix", "remove" — not "added", "adds", "fixing"), lowercase after the
  colon, no trailing period.
- Subject line under ~50 characters where possible, hard cap ~72.
- If the change breaks backward compatibility, append `!` before the colon (`feat(api)!: ...`) **and** add a
  `BREAKING CHANGE:` footer explaining the break.
- Lead the body with *why*, not *what*. The diff already shows what changed; a reader with the diff open
  doesn't need it repeated in prose. State the reason, motivation, or problem being solved.
- Use a body only when the subject line can't carry the necessary context — a one-line change with an
  obvious reason doesn't need one. Wrap body lines at ~72 characters, separated from the subject by one
  blank line.

## 4. Follow Existing Convention

- Before writing a message, check `git log --oneline -20` on the current repo to confirm the prevailing
  style still matches Section 3 (type casing, scope naming). Match it.
- The type prefix itself is never optional in this repo — the commit-msg hook and CI both reject a subject
  line without one, so there is no "no convention discernible" fallback to a bare imperative subject.

## 5. Issue References — Always Ask

- Before finalizing any commit message, ask the user whether this commit should close an issue, and if so,
  what to include:
  - **Closes/Fixes #N** — use only when this commit fully resolves the issue; it auto-closes on merge.
  - **Refs #N** / "Relates to #N" — use when the commit is related but doesn't fully resolve the issue; it
    links without closing.
- Never invent an issue number, and never guess Closes vs. Refs on the user's behalf — always confirm which
  one they want, and for which number, even if a plausible issue seems implied by the task.
- Don't mix `Closes` and `Refs` for the same issue across multiple commits on one branch.

## 6. What Not to Do

- Don't claim a commit "fixes" or "resolves" something without having verified it (see
  `agemon-verify-before-done`) — a commit message is a durable record, and false claims in it mislead
  future readers doing `git blame` archaeology.
- Never add attribution, co-author, or tool-generated lines (e.g. `Co-Authored-By: <agent name>`,
  "Generated with ..."). The message is authored by the user; it carries no mention of the agent or tool
  that drafted it, even if a session-level default elsewhere suggests otherwise.
- Don't amend or rewrite history (`commit --amend`, rebase) on commits already pushed or shared, and never
  force-push, without explicit confirmation.
