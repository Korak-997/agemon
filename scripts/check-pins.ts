import { errorMessage } from "../src/core/error-message.js";
import {
  AGNIX_VERSION,
  CODE_REVIEW_GRAPH_VERSION,
  ESSENTIALS_SKILLS_COMMIT,
  ESSENTIALS_SKILLS_REPOSITORY_URL,
} from "../src/plugins/pins.js";
import { SKILL_GROUPS } from "../src/plugins/skills/catalog.js";
import { skillPathInRepository } from "../src/plugins/skills/pinned-source.js";
import {
  compareVersions,
  githubCommitSummaries,
  newestSettledCommitAfterPin,
  newestSettledVersion,
  npmReleases,
  pypiReleases,
} from "./check-pins/freshness.js";

const REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_COMMITS_PER_PATH = 30;

interface PinCheck {
  name: string;
  pinned: string;
  findNewer: (now: Date) => Promise<string | undefined>;
  bumpReminder?: string;
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

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "agemon-check-pins",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function githubRepositoryPath(repositoryUrl: string): string {
  const [owner, repository] = new URL(repositoryUrl).pathname
    .replace(/^\//u, "")
    .replace(/\.git$/u, "")
    .split("/");
  return `${owner}/${repository}`;
}

function newerVersion(
  pinned: string,
  newestSettled: string | undefined,
): string | undefined {
  return newestSettled && compareVersions(newestSettled, pinned) > 0
    ? newestSettled
    : undefined;
}

async function findNewerEssentialsCommit(
  now: Date,
): Promise<string | undefined> {
  const commitsApi = `https://api.github.com/repos/${githubRepositoryPath(
    ESSENTIALS_SKILLS_REPOSITORY_URL,
  )}/commits`;
  const [pinnedCommit] = githubCommitSummaries([
    await fetchJson(
      `${commitsApi}/${ESSENTIALS_SKILLS_COMMIT}`,
      githubHeaders(),
    ),
  ]);
  const essentialsSkillPaths = SKILL_GROUPS.flatMap((group) => group.skills)
    .filter(
      (skill) => skill.pinnedRepository?.commit === ESSENTIALS_SKILLS_COMMIT,
    )
    .map((skill) => skillPathInRepository(skill.skillName));

  const commitsTouchingSkills = [];
  for (const skillPath of essentialsSkillPaths) {
    const query = new URLSearchParams({
      path: skillPath,
      per_page: String(GITHUB_COMMITS_PER_PATH),
    });
    commitsTouchingSkills.push(
      ...githubCommitSummaries(
        await fetchJson(`${commitsApi}?${query}`, githubHeaders()),
      ),
    );
  }
  return newestSettledCommitAfterPin({
    pinnedCommittedAt: pinnedCommit?.committedAt ?? "",
    commits: commitsTouchingSkills,
    now,
  });
}

const PIN_CHECKS: PinCheck[] = [
  {
    name: "code-review-graph (PyPI)",
    pinned: CODE_REVIEW_GRAPH_VERSION,
    findNewer: async (now) =>
      newerVersion(
        CODE_REVIEW_GRAPH_VERSION,
        newestSettledVersion(
          pypiReleases(
            await fetchJson("https://pypi.org/pypi/code-review-graph/json"),
          ),
          now,
        ),
      ),
  },
  {
    name: "agnix (npm)",
    pinned: AGNIX_VERSION,
    findNewer: async (now) =>
      newerVersion(
        AGNIX_VERSION,
        newestSettledVersion(
          npmReleases(await fetchJson("https://registry.npmjs.org/agnix")),
          now,
        ),
      ),
    bumpReminder:
      "a bump also needs the sha256 of every release archive in AGNIX_RELEASE_ARCHIVE_SHA256 (src/plugins/pins.ts)",
  },
  {
    name: "Essentials skills (vercel-labs/agent-skills)",
    pinned: ESSENTIALS_SKILLS_COMMIT,
    findNewer: findNewerEssentialsCommit,
  },
];

async function main(): Promise<void> {
  const now = new Date();
  let needsAttention = false;
  for (const check of PIN_CHECKS) {
    try {
      const newer = await check.findNewer(now);
      if (!newer) {
        console.log(`ok      ${check.name}: ${check.pinned}`);
        continue;
      }
      needsAttention = true;
      console.log(
        `behind  ${check.name}: pinned ${check.pinned}, ${newer} has been out for 7+ days`,
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
