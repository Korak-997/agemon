# Test fixture: Essentials skills as installed before agemon bundled them

- Source: https://github.com/vercel-labs/agent-skills
- Commit: 063bee94c3f4df8453406c830b0a7df0f2860278 (paths `skills/web-design-guidelines/SKILL.md` and `skills/writing-guidelines/SKILL.md`)
- License: the repository's README states MIT; it has no LICENSE file at that commit, so the licence is stated, not shipped.
- Use: these copies stand in for what older agemon releases installed. Tests check that they are recognised and offered an update, and the design eval installs them where a ref has no bundled `essentials` group.
- This file sits beside the skill folders on purpose, so it does not change any per-skill fingerprint.
