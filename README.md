# agemon

One command to bootstrap and later reverse an AI coding agent environment in a repository.

## Quickstart

Prerequisites:
- Ubuntu
- Node.js 24+
- npx

Install into the current repository:

```bash
npx agemon@latest install
```

Dry run (show what would change):

```bash
npx agemon@latest install --dry-run
```

Reverse agemon-managed changes:

```bash
npx agemon@latest nuke
```

Use the installer script (preflight + delegate):

```bash
sh ./install.sh
```

## Local Development

```bash
npm install
npm run build
npm test
```

Sandbox workflows:

```bash
npm run sandbox -- run clean-repo --dry-run
npm run sandbox -- roundtrip clean-repo
```

## Commands

- `agemon install`
- `agemon nuke`
- `agemon status` (planned)
- `agemon doctor` (planned)

## License

MIT
