# Team Engineering Rules

These rules are written and owned by the team. They predate agemon and must survive
any reconciliation byte-for-byte.

## Workflow

1. Open a tracking issue before starting non-trivial work.
2. Branch from `main`; never commit directly to it.
3. Rebase, do not merge, when updating a feature branch.
4. Squash to a single logical commit before requesting review.
5. A review needs one approval from a code owner plus a green CI run.

## Style

- Two-space indentation in every language we use here.
- Prefer pure functions; isolate side effects at the edges.
- Name things for what they mean, not for their type.
- Delete dead code in the same change that orphans it.

## Testing

- Every bug fix ships with a regression test that fails before the fix.
- Unit tests must not touch the network or the clock.
- Keep the full suite under two minutes locally.

## Releases

- Tag releases `vMAJOR.MINOR.PATCH`; changelog entry is mandatory.
- Only the on-call engineer cuts a release.
- Roll forward for hotfixes; never rewrite a published tag.
