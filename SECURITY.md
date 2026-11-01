# Security policy

agemon is maintained on a best-effort basis. This policy describes what you can expect.
It does not set deadlines.

## Supported versions

Only the **latest release** gets security fixes. Fixes are not backported to older minors.

## Reporting a vulnerability

Please report privately. Do **not** open a public issue with details.

- **Preferred:** GitHub private vulnerability reporting, under the repository's
  [Security → Report a vulnerability](https://github.com/Korak-997/agemon/security/advisories/new).
- **If that is unavailable:** open a public issue that says only that you have a security
  report and would like a private contact. Leave out every detail.

Include the agemon version (`agemon --version`), your OS, steps to reproduce, and the
impact you expect.

## What to expect

These are best-effort targets, not guarantees:

- acknowledgement within about **7 days**;
- an assessment and a rough plan once the report has been reproduced;
- coordinated disclosure: details are published together with the fix, and you are
  credited unless you prefer not to be.

There is no bug bounty.

## Scope

In scope:

- the `agemon` CLI (this repository's `src/` and `bin/`);
- `install.sh` and the self-update path;
- release artifacts published from this repository;
- the vendored skill copies under `assets/skills/`. Please also report problems that come
  from the original skill to its upstream project. Each skill's `NOTICE.md` names it.

Out of scope (report these upstream):

- third-party tools that agemon installs or runs, such as the `skills` CLI,
  code-review-graph, agnix, pipx and npm;
- the content of skills that agemon installs from remote sources and does not vendor.
  How agemon fetches, pins or verifies them is in scope.

## Trust model

agemon treats **repository contents** (`agemon.toml`, `.agemon/` state and plan files,
existing instruction files) and **network responses** as untrusted. It trusts the
**local user**, meaning the environment variables and CLI arguments of the person running
it. The clearest reports show untrusted input crossing that boundary, for example a cloned
repository's plan file that makes agemon write outside the repository. Dangerous handling of
the local user's own input, such as a destructive default, is still worth reporting.
