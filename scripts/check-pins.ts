import { errorMessage } from "../src/core/error-message.js";
import { printable } from "../src/core/untrusted-text.js";
import {
  AGNIX_VERSION,
  CODE_REVIEW_GRAPH_VERSION,
  GITLEAKS_VERSION,
} from "../src/plugins/pins.js";
import {
  compareVersions,
  declaredInstallDependencies,
  githubReleases,
  newestSettledVersion,
  npmReleases,
  type PublishedRelease,
  pinnedReleaseProblem,
  pypiReleases,
} from "./check-pins/freshness.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LISTED_NAMES = 10;
const MAX_UPSTREAM_TEXT_CHARACTERS = 100;
const GITHUB_RELEASES_PER_PAGE = 100;

interface PinProblem {
  kind: "refuse" | "problem";
  detail: string;
}

interface PinInspection {
  newer: string | undefined;
  problems: PinProblem[];
}

interface PinCheck {
  name: string;
  pinned: string;
  inspect: (now: Date) => Promise<PinInspection>;
  bumpReminder?: string;
}

function upstreamText(value: string): string {
  const shown = printable(value);
  return shown.length > MAX_UPSTREAM_TEXT_CHARACTERS
    ? `${shown.slice(0, MAX_UPSTREAM_TEXT_CHARACTERS)}…`
    : shown;
}

function listUpstreamNames(names: string[]): string {
  const listed = names.slice(0, MAX_LISTED_NAMES).map(upstreamText).join(", ");
  const unlisted = names.length - MAX_LISTED_NAMES;
  return unlisted > 0 ? `${listed} and ${unlisted} more` : listed;
}

function pinnedReleaseProblems(
  releases: PublishedRelease[],
  pinned: string,
): PinProblem[] {
  const problem = pinnedReleaseProblem(releases, pinned);
  return problem === undefined
    ? []
    : [{ kind: "problem", detail: `pinned ${pinned} is ${problem}` }];
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`unexpected response: HTTP ${response.status} from ${url}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`unexpected response: invalid JSON from ${url}`);
  }
}

function newerVersion(
  pinned: string,
  newestSettled: string | undefined,
): string | undefined {
  return newestSettled && compareVersions(newestSettled, pinned) > 0
    ? newestSettled
    : undefined;
}

const PIN_CHECKS: PinCheck[] = [
  {
    name: "code-review-graph (PyPI)",
    pinned: CODE_REVIEW_GRAPH_VERSION,
    inspect: async (now) => {
      const releases = pypiReleases(
        await fetchJson("https://pypi.org/pypi/code-review-graph/json"),
      );
      return {
        newer: newerVersion(
          CODE_REVIEW_GRAPH_VERSION,
          newestSettledVersion(releases, now),
        ),
        problems: pinnedReleaseProblems(releases, CODE_REVIEW_GRAPH_VERSION),
      };
    },
    bumpReminder:
      'a bump also regenerates assets/tools/code-review-graph-constraints.txt: echo "code-review-graph==<version>" | uv pip compile - --universal --generate-hashes --python-version 3.10 --no-annotate -o assets/tools/code-review-graph-constraints.txt',
  },
  {
    name: "agnix (npm)",
    pinned: AGNIX_VERSION,
    inspect: async (now) => {
      const packument = await fetchJson("https://registry.npmjs.org/agnix");
      const releases = npmReleases(packument);
      const dependencies = declaredInstallDependencies(
        packument,
        AGNIX_VERSION,
      );
      return {
        newer: newerVersion(AGNIX_VERSION, newestSettledVersion(releases, now)),
        problems: [
          ...pinnedReleaseProblems(releases, AGNIX_VERSION),
          ...(dependencies.length > 0
            ? [
                {
                  kind: "refuse" as const,
                  detail: `pinned ${AGNIX_VERSION} declares dependencies npm would fetch unverified: ${listUpstreamNames(dependencies)}`,
                },
              ]
            : []),
        ],
      };
    },
    bumpReminder:
      "a bump also needs, in src/plugins/pins.ts: the sha256 of every release archive (AGNIX_RELEASE_ARCHIVE_SHA256) and of the agnix binary inside each (AGNIX_BINARY_SHA256), the npm tarball's dist.integrity (AGNIX_NPM_TARBALL), and the sha256 of its package.json and bin/agnix after a real npm install (AGNIX_PACKAGE_FILE_SHA256)",
  },
  {
    name: "gitleaks (GitHub releases)",
    pinned: GITLEAKS_VERSION,
    inspect: async (now) => {
      const releases = githubReleases(
        await fetchJson(
          `https://api.github.com/repos/gitleaks/gitleaks/releases?per_page=${GITHUB_RELEASES_PER_PAGE}`,
          { accept: "application/vnd.github+json" },
        ),
      );
      return {
        newer: newerVersion(
          GITLEAKS_VERSION,
          newestSettledVersion(releases, now),
        ),
        problems: pinnedReleaseProblems(releases, GITLEAKS_VERSION),
      };
    },
    bumpReminder:
      "a bump also needs, in src/plugins/pins.ts: the sha256 of every release archive (GITLEAKS_RELEASE_ARCHIVE_SHA256), computed from the downloaded files and cross-checked against gitleaks_<version>_checksums.txt; the asset names in src/plugins/cli-tool/catalog.ts carry the version too",
  },
];

async function main(): Promise<void> {
  const now = new Date();
  let needsAttention = false;
  for (const check of PIN_CHECKS) {
    try {
      const { newer, problems } = await check.inspect(now);
      for (const problem of problems) {
        console.log(
          `${problem.kind.padEnd(7)} ${check.name}: ${problem.detail}`,
        );
      }
      if (problems.length > 0) {
        needsAttention = true;
      }
      if (!newer) {
        if (problems.length === 0) {
          console.log(`ok      ${check.name}: ${check.pinned}`);
        }
        continue;
      }
      needsAttention = true;
      console.log(
        `behind  ${check.name}: pinned ${check.pinned}, ${upstreamText(newer)} has been out for 7+ days`,
      );
      if (check.bumpReminder) {
        console.log(`        ${check.bumpReminder}`);
      }
    } catch (error) {
      needsAttention = true;
      console.log(`error   ${check.name}: ${errorMessage(error)}`);
    }
  }
  process.exitCode = needsAttention ? 1 : 0;
}

await main();
