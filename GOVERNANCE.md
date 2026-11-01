# Governance

agemon is a small project. This file says who decides what, and how that can change.

## Maintainers

| Maintainer | Areas |
|---|---|
| [@Korak-997](https://github.com/Korak-997) | everything |

Maintainers review and merge pull requests, triage issues, cut releases and handle security
reports (see [SECURITY.md](SECURITY.md)).

## How decisions are made

- Day-to-day changes are decided in the pull request: a maintainer approves and merges it.
- Larger changes (a new capability, a new skill group, a change to the safety model of plan →
  consent → apply → rollback, or a breaking change) start as an issue, so the design can be
  discussed before code is written.
- When maintainers disagree, they discuss in the issue until they agree. While there is one
  maintainer, that maintainer decides.
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Becoming a maintainer

Maintainers invite contributors who have made sustained, high-quality contributions over a
period of time: merged pull requests, careful reviews, and help with issues. Ask a maintainer
in an issue if you are interested. A maintainer who stops being active may step down, or be
moved to an emeritus list after a discussion.

## Code owners and review

`.github/CODEOWNERS` assigns every file to the maintainers, so changes to the skill lint,
the workflows and the bundled skills always need a maintainer's review. While there is only
one maintainer, that maintainer merges their own pull requests through the administrator
path; code-owner review becomes a real second check once there is a second maintainer.

## Releases

There is no fixed cadence. A maintainer cuts a release when `master` has user-facing changes
worth shipping, and right away for security fixes. The process is in
[docs/releasing.md](docs/releasing.md); only the latest release receives fixes.

## Changing this document

Changes to this file go through a pull request like any other change and need a maintainer's
approval.
