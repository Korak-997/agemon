# Vendored skill

- Source: https://github.com/cloudflare/security-audit-skill
- Path in source: skills/security-audit
- Commit: c1c8a8c1471069fb0e188eeaff69b8e8db6564a8
- Retrieved: 2026-11-05
- License: MIT — see `LICENSE` in this directory.

## agemon modifications

- Renamed from `security-audit` to `agemon-security-audit`.
- Left out upstream's `validate-findings.test.cjs` and `validate-coverage-ledger.test.cjs`: they test the validators and the skill does not use them.
