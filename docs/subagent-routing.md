# How agemon routes subagents

agemon puts the cheap model on read-heavy work and keeps your session model on judgment, enforced by
files it reconciles on every run, not by prompts.

This page shows the files agemon writes for Claude Code, how to check what they do in your own
repository, and when delegating to a subagent costs more than doing the work in the main
conversation. It covers Claude Code only.

## What changes in your repository

agemon writes three kinds of file for routing. Each one goes through the usual plan and consent
step, and `agemon nuke` removes it.

### The Explore override

Claude Code delegates code searches to its built-in `Explore` agent, which runs on the Opus alias
for subscription users. The `agents` capability installs a project agent with the same name, so
Claude Code runs `Explore` on Haiku in this repository. It doesn't depend on a skill group.
`.claude/agents/explore.md` starts like this:

```markdown
---
name: Explore
description: "Fast read-only codebase exploration: finds files, traces usages and answers where/how questions. Reports paths and lines with a short summary; changes nothing."
tools: Read, Grep, Glob
model: haiku
effort: medium
maxTurns: 30
---
```

The rest of the file is the scout's brief, which asks for a report under 400 words. If another file
in `.claude/agents/` already declares `name: Explore`, agemon leaves it alone and says so. If
`explore.md` exists and isn't agemon's, it is a conflict that you decide, like any agent file.

### The workflow role agents

The `workflow` skill group adds two role agents. `agemon-scout` searches on Haiku, and
`agemon-worker` implements a written spec on Sonnet:

```markdown
---
name: agemon-scout
description: "Use proactively for read-only searches that would pull many files or long logs into the conversation: finding code, tracing usages, digesting logs. Runs on the cheapest model and reports paths and lines; changes nothing."
tools: Read, Grep, Glob
model: haiku
effort: medium
maxTurns: 30
---
```

`agemon-worker` has the same keys with `model: sonnet`, `maxTurns: 50`, and also gets `Edit`,
`Write` and `Bash`. Medium effort is deliberate: on Haiku, higher effort made searches slower and
more expensive with no accuracy gain in an
[independent test](https://www.aiviolabs.com/en/blog/haiku-5-5-as-a-subagent).

### The fallback model

The `subagent-default` capability sets one key in `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"
  }
}
```

A subagent runs on the first of these that is set: the model named in the call, the agent file's
`model`, this variable, then the session's model. So the variable only reaches subagents that
would otherwise inherit the session's model. See
[Default subagent model](../README.md#default-subagent-model) for when it raises your cost.

### The rules

The rules block agemon writes into `AGENTS.md` tells Claude when to delegate:

```markdown
## Subagent Models

- A few tool calls: do them yourself. A subagent pays for its own startup context.
- Read-heavy searches across many files or long logs: delegate to `Explore`, which agemon runs on the cheapest tier, and ask for a short report.
- Pass `model` whenever you spawn any other subagent.
- Mid tier: routine implementation and reviews. Top tier: cross-module debugging, security or concurrency review, architecture, final branch review.
- Never delegate to a subagent on the same model as the session to save money, and never fan out parallel subagents for one question.
- Failed twice on one task: go one tier up.
```

Rules are advice that Claude may not follow. The agent files and the settings key are what
Claude Code enforces.

## Measure it yourself

`agemon usage` reads the sessions Claude Code already saves for this repository and reports where
the cost went. It calls no model:

```sh
agemon usage --since 30d
```

The report has these lines, with your own figures in place of the placeholders:

```text
Sessions: session_count, of which subagent_session_count used subagents
Main session $main_cost (main_share) · subagents $subagent_cost (subagent_share)
Subagent calls: call_count, of which cheaper_call_count ran cheaper than the session's model
  Explore: explore_call_count calls (haiku ×haiku_call_count), cost $explore_cost, saving $explore_saving
```

- **Main session against subagents**: how the cost splits between the conversation you see and
  the subagents it started.
- **One row per agent type**: which models that type actually ran on, and how often. Explore
  should show `haiku`.
- **A top-tier Explore warning**: if any Explore call ran on Opus or Fable, the report says so
  and tells you to run `agemon`.

The saving it shows reprices the subagents' tokens at the session's model. It doesn't show what
doing the work in the main conversation would have cost, or whether the cheaper work was good
enough. The README's
[`agemon usage` section](../README.md#checking-what-subagent-models-saved-agemon-usage) lists its
other limits.

## When routing helps and when it doesn't

Delegation saves money only when a much cheaper model reads a lot and the main conversation reads
a short report. Anthropic's
[cost guide](https://code.claude.com/docs/en/costs) recommends delegating verbose operations to
subagents and choosing a smaller model for them, because a subagent's own requests still count.

It helps with:

- **Large read-heavy searches**: Haiku answered Explore-style inventory questions correctly at a
  small fraction of Opus's cost in an
  [independent test](https://www.aiviolabs.com/en/blog/haiku-5-5-as-a-subagent).
- **Long logs and test output**: the subagent reads them, and the main conversation keeps only
  the finding.

It costs more with:

- **Tiny tasks**: a subagent starts with its own context, so a few tool calls are cheaper in the
  main conversation.
- **A subagent on the session's model**: in a
  [288-run practitioner study](https://dev.to/jaehyun_cho_0dff271e0d2e5/i-told-claude-code-to-use-subagents-216-times-it-found-nothing-more-and-cost-up-to-221-more-14ea),
  telling Claude to use Explore subagents for code search raised the cost per run on both Haiku
  and Opus sessions and found nothing more. The subagents ran on the same model as the session.
- **Parallel fan-out**: several searchers for one question raise what the main conversation has
  to read. Cognition [reports](https://cognition.com/blog/multi-agents-working) that read-only
  search subagents work, while parallel writers failed, and Anthropic's
  [multi-agent write-up](https://www.anthropic.com/engineering/multi-agent-research-system) calls
  most coding tasks a poor fit for multi-agent setups.

agemon's own eval hasn't measured a saving yet, and agemon claims none. The
[evidence page](https://agemon.korak-kurani.com/posts/routing-evidence/) has every result so far,
and [`evals/routing/README.md`](../evals/routing/README.md) has the method and the pre-registered
pass rule.

## Opt-in: the delegation guard

The `delegation-guard` capability is experimental: it hasn't been measured in agemon's eval yet.
It is never installed by default. An interactive `agemon` run offers it once, or you can add it:

```sh
agemon add delegation-guard
```

It installs `.claude/hooks/agemon-delegation-guard.mjs` and three hook entries in
`.claude/settings.json`. Once installed, it stays off in every chat until you agree:

1. At the start of each new chat, Claude asks you once whether to turn the guard on.
2. If you say yes, the guard allows 12 `Read`, `Grep` and `Glob` calls per message in the main
   conversation. The next one is denied with a reason that points Claude to `Explore`.
3. While it is on, it also denies subagent calls that ask for `opus`.

Subagents are never counted. Set `AGEMON_GUARD=on` to turn it on without the question, for
example in headless runs, or `AGEMON_GUARD=off` to disable it. The hook exits without output on
any payload it doesn't recognise, so other tools that read `.claude/settings.json`, such as
Copilot CLI, keep working. It needs Claude Code 2.1.251 or later.
