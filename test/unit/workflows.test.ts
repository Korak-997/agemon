import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS_DIRECTORY = ".github/workflows";
const PINNED_ACTION_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/;
const FIRST_PARTY_ACTION_PREFIXES = ["actions/", "./"];
const THIRD_PARTY_COMMAND_PATTERN = /\b(npm|npx|node|tsx|docker)\b/;
const CREDENTIAL_EXPRESSION_PATTERN = /\$\{\{\s*(github\.token|secrets\.)/;

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  permissions?: unknown;
  uses?: string;
  container?: unknown;
  services?: unknown;
  needs?: string | string[];
  environment?: unknown;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflows(): Map<string, Workflow> {
  return new Map(
    readdirSync(WORKFLOWS_DIRECTORY)
      .filter((file) => file.endsWith(".yml"))
      .map((file) => [
        file,
        parse(readFileSync(join(WORKFLOWS_DIRECTORY, file), "utf8")),
      ]),
  );
}

function holdsWriteScope(workflow: Workflow, job: WorkflowJob): boolean {
  const permissions = job.permissions ?? workflow.permissions;
  if (permissions === undefined || permissions === "write-all") {
    return true;
  }
  if (typeof permissions === "string") {
    return false;
  }
  return Object.values(permissions as Record<string, string>).includes("write");
}

function runsThirdPartyCode(job: WorkflowJob): boolean {
  return (job.steps ?? []).some(
    (step) =>
      THIRD_PARTY_COMMAND_PATTERN.test(step.run ?? "") ||
      (step.uses !== undefined &&
        !FIRST_PARTY_ACTION_PREFIXES.some((prefix) =>
          step.uses?.startsWith(prefix),
        )),
  );
}

function unpinnedActions(workflow: Workflow): string[] {
  return Object.values(workflow.jobs).flatMap((job) =>
    [job.uses, ...(job.steps ?? []).map((step) => step.uses)].filter(
      (uses): uses is string =>
        uses !== undefined &&
        !uses.startsWith("./") &&
        !PINNED_ACTION_PATTERN.test(uses),
    ),
  );
}

const NPM_PUBLISH_JOB = { file: "release.yml", job: "npm" } as const;
const SCORECARD_JOB = { file: "scorecard.yml", job: "analysis" } as const;
const JOBS_ALLOWED_THIRD_PARTY_CODE_WITH_WRITE_SCOPE = [
  NPM_PUBLISH_JOB,
  SCORECARD_JOB,
];

function privilegedThirdPartyJobs(
  workflow: Workflow,
  exemptJobNames: readonly string[] = [],
): string[] {
  return Object.entries(workflow.jobs)
    .filter(
      ([jobName, job]) =>
        !exemptJobNames.includes(jobName) &&
        runsThirdPartyCode(job) &&
        holdsWriteScope(workflow, job),
    )
    .map(([jobName]) => jobName);
}

function stepUsing(job: WorkflowJob, action: string): WorkflowStep | undefined {
  return job.steps?.find((step) => step.uses?.startsWith(`${action}@`));
}

function stepRunning(
  job: WorkflowJob,
  pattern: RegExp,
): WorkflowStep | undefined {
  return job.steps?.find((step) => pattern.test(step.run ?? ""));
}

const workflows = loadWorkflows();

describe("workflow policy checks", () => {
  it("flag an unpinned action", () => {
    const workflow: Workflow = {
      permissions: {},
      jobs: { build: { steps: [{ uses: "actions/checkout@v4" }] } },
    };
    expect(unpinnedActions(workflow)).toEqual(["actions/checkout@v4"]);
  });

  it("flag an npm job that inherits a write token", () => {
    const workflow: Workflow = {
      permissions: { contents: "write" },
      jobs: { build: { steps: [{ run: "npm ci" }] } },
    };
    expect(privilegedThirdPartyJobs(workflow)).toEqual(["build"]);
  });

  it("flag a third-party action in a job with any write scope", () => {
    const workflow: Workflow = {
      permissions: {},
      jobs: {
        label: {
          permissions: { "pull-requests": "write" },
          steps: [{ uses: "someone/action@v1" }],
        },
      },
    };
    expect(privilegedThirdPartyJobs(workflow)).toEqual(["label"]);
  });

  it("treat a workflow without any permissions block as privileged", () => {
    const workflow: Workflow = {
      jobs: { build: { steps: [{ run: "npm test" }] } },
    };
    expect(privilegedThirdPartyJobs(workflow)).toEqual(["build"]);
  });
});

describe(".github/workflows", () => {
  it.each([...workflows.keys()])(
    "%s pins every action to a commit SHA",
    (file) => {
      expect(unpinnedActions(workflows.get(file) as Workflow)).toEqual([]);
    },
  );

  it.each([...workflows.keys()])(
    "%s declares top-level permissions",
    (file) => {
      expect(workflows.get(file)?.permissions).toBeDefined();
    },
  );

  it("never runs third-party code in a job that holds a write token", () => {
    const offenders = [...workflows].flatMap(([file, workflow]) =>
      privilegedThirdPartyJobs(
        workflow,
        JOBS_ALLOWED_THIRD_PARTY_CODE_WITH_WRITE_SCOPE.filter(
          (allowed) => allowed.file === file,
        ).map((allowed) => allowed.job),
      ).map((jobName) => `${file}:${jobName}`),
    );
    expect(offenders).toEqual([]);
  });

  it("prepares the release commit without credentials", () => {
    const tagJob = workflows.get("cut-release.yml")?.jobs.tag as WorkflowJob;

    expect(
      stepUsing(tagJob, "actions/checkout")?.with?.["persist-credentials"],
    ).toBe(false);
    expect(stepRunning(tagJob, /npm ci/)?.run).toMatch(
      /npm ci --ignore-scripts/,
    );
    expect(stepRunning(tagJob, /npm run deploy/)?.run).toMatch(
      /--skip-checks --no-push/,
    );
  });

  it("pushes the release commit only after checking what it changes", () => {
    const cutRelease = workflows.get("cut-release.yml") as Workflow;
    const credentialJobs = Object.entries(cutRelease.jobs).filter(([, job]) =>
      (job.steps ?? []).some((step) =>
        CREDENTIAL_EXPRESSION_PATTERN.test(JSON.stringify(step)),
      ),
    );

    expect(credentialJobs.map(([jobName]) => jobName)).toEqual(["push"]);
    const pushJob = credentialJobs[0][1];
    expect(stepUsing(pushJob, "actions/checkout")).toBeUndefined();
    const verification = stepRunning(pushJob, /git diff --raw/)?.run;
    expect(verification).toContain(
      "CHANGELOG\\.md|package\\.json|package-lock\\.json",
    );
    expect(verification).toContain(
      `jq -S 'del(.version, .packages[""].version)'`,
    );
    expect(verification).toContain("git bundle verify");
  });

  it("publishes releases from a job that runs no repository code", () => {
    const publishJob = workflows.get("release.yml")?.jobs
      .publish as WorkflowJob;

    expect(stepUsing(publishJob, "actions/checkout")).toBeUndefined();
    expect(runsThirdPartyCode(publishJob)).toBe(false);
  });

  it("checks pin freshness read-only, with the token on the check step only", () => {
    const checkJob = workflows.get("pin-freshness.yml")?.jobs[
      "check-pins"
    ] as WorkflowJob;
    const credentialSteps = (checkJob.steps ?? []).filter((step) =>
      CREDENTIAL_EXPRESSION_PATTERN.test(JSON.stringify(step)),
    );

    expect(checkJob.permissions).toEqual({ contents: "read" });
    expect(
      stepUsing(checkJob, "actions/checkout")?.with?.["persist-credentials"],
    ).toBe(false);
    expect(stepRunning(checkJob, /npm ci/)?.run).toBe(
      "npm ci --ignore-scripts",
    );
    expect(credentialSteps.map((step) => step.run)).toEqual([
      "npm run check-pins",
    ]);
  });

  it.each([
    "release.yml",
    "cut-release.yml",
    "pin-freshness.yml",
    "website.yml",
  ])("%s restores no dependency cache", (file) => {
    const workflow = workflows.get(file) as Workflow;
    for (const job of Object.values(workflow.jobs)) {
      expect(stepUsing(job, "actions/setup-node")?.with?.cache).toBeUndefined();
    }
  });

  it("lints the bundled skills in CI", () => {
    const qualityJob = workflows.get("ci.yml")?.jobs.quality as WorkflowJob;

    expect(stepRunning(qualityJob, /^npm run lint-skills$/)).toBeDefined();
  });

  describe("the Scorecard job, allowed to run the pinned Scorecard action with write scopes", () => {
    const scorecardWorkflow = workflows.get(SCORECARD_JOB.file) as Workflow;
    const scorecardJob = workflows.get(SCORECARD_JOB.file)?.jobs[
      SCORECARD_JOB.job
    ] as WorkflowJob;

    it("never runs for pull requests and has no container or services", () => {
      expect(Object.keys(scorecardWorkflow.on ?? {}).sort()).toEqual([
        "branch_protection_rule",
        "push",
        "schedule",
        "workflow_dispatch",
      ]);
      expect(Object.keys(scorecardWorkflow.jobs)).toEqual([SCORECARD_JOB.job]);
      expect(scorecardJob.container).toBeUndefined();
      expect(scorecardJob.services).toBeUndefined();
    });

    it("holds only the scopes Scorecard needs to publish and upload results", () => {
      expect(scorecardJob.permissions).toEqual({
        contents: "read",
        "security-events": "write",
        "id-token": "write",
      });
    });

    it("runs no repository code: only checkout without credentials, Scorecard and the SARIF upload", () => {
      const steps = scorecardJob.steps ?? [];
      expect(steps.filter((step) => step.run)).toEqual([]);
      expect(steps.map((step) => step.uses?.split("@")[0])).toEqual([
        "actions/checkout",
        "ossf/scorecard-action",
        "github/codeql-action/upload-sarif",
      ]);
      expect(
        stepUsing(scorecardJob, "actions/checkout")?.with?.[
          "persist-credentials"
        ],
      ).toBe(false);
    });
  });

  describe("the npm publish job, the one job allowed to run npm with id-token: write", () => {
    const npmJob = workflows.get(NPM_PUBLISH_JOB.file)?.jobs[
      NPM_PUBLISH_JOB.job
    ] as WorkflowJob;
    const runSteps = (npmJob?.steps ?? []).filter((step) => step.run);

    it("holds only contents: read and id-token: write, behind the npm environment", () => {
      expect(npmJob.permissions).toEqual({
        contents: "read",
        "id-token": "write",
      });
      expect(npmJob.environment).toBe("npm");
      expect(npmJob.needs).toEqual(["build", "publish"]);
    });

    it("runs exactly the reviewed steps", () => {
      expect(
        (npmJob.steps ?? []).map((step) => (step as { name?: string }).name),
      ).toEqual([
        "Download the published release assets",
        "Verify the tarball is the one the build job checksummed",
        "Setup Node.js",
        "Require an npm that supports trusted publishing",
        "Choose the dist-tag",
        "Publish to npm",
      ]);
      expect(
        (npmJob.steps ?? []).flatMap((step) =>
          step.uses ? [step.uses.split("@")[0]] : [],
        ),
      ).toEqual(["actions/setup-node"]);
    });

    it("never checks out the repository or restores a cache", () => {
      expect(stepUsing(npmJob, "actions/checkout")).toBeUndefined();
      expect(
        stepUsing(npmJob, "actions/setup-node")?.with?.cache,
      ).toBeUndefined();
      for (const step of npmJob.steps ?? []) {
        expect(
          step.uses === undefined || step.uses.startsWith("actions/"),
        ).toBe(true);
      }
    });

    it("publishes the release's checksummed tarball, not a fresh build", () => {
      const commands = runSteps.map((step) => step.run ?? "").join("\n");

      expect(commands).toContain("gh release download");
      expect(commands).toContain("EXPECTED_CHECKSUMS_DIGEST");
      expect(commands).toMatch(/agemon\\\.tgz\$' SHA256SUMS \| sha256sum -c -/);
      expect(commands).toContain('npm publish ./agemon.tgz --tag "$DIST_TAG"');
      expect(commands).not.toMatch(/\bnpx\b|npm (ci|install|run)\b|\bnode\b/);
    });

    it("refuses an npm older than 11.5.1 and never moves latest backwards", () => {
      const commands = runSteps.map((step) => step.run ?? "").join("\n");

      expect(commands).toContain("11.5.1");
      expect(commands).toContain("npm view agemon dist-tags.latest");
      expect(commands).toContain("sort -V");
    });

    it("publishes prereleases under next and passes the tag through env", () => {
      const tagStep = runSteps.find((step) => /DIST_TAG=/.test(step.run ?? ""));

      expect(tagStep?.run).toMatch(/-alpha\.\*.*-beta\.\*.*-rc\.\*/s);
      expect(tagStep?.run).toContain("DIST_TAG=next");
      for (const step of runSteps) {
        expect(step.run).not.toMatch(/\$\{\{/);
      }
    });
  });

  it("packs release and smoke-test tarballs with the dependency-stripping script", () => {
    const buildJob = workflows.get("release.yml")?.jobs.build as WorkflowJob;

    expect(stepRunning(buildJob, /pack-release\.sh/)?.run).toContain(
      "sh scripts/pack-release.sh release-assets/agemon.tgz",
    );
    expect(stepRunning(buildJob, /npm pack/)).toBeUndefined();
  });

  it("tests every supported Node line and dry-runs the npm publish in CI", () => {
    const qualityJob = workflows.get("ci.yml")?.jobs.quality as WorkflowJob & {
      strategy: { matrix: { "node-version": string[] } };
    };

    expect(qualityJob.strategy.matrix["node-version"]).toEqual([
      "22.x",
      "24.x",
      "26.x",
    ]);
    expect(stepRunning(qualityJob, /npm publish --dry-run/)?.run).toContain(
      "pack-release.sh",
    );
  });
});

const SCOPE_LEVELS: Record<string, number> = { none: 0, read: 1, write: 2 };

function jobScopes(
  workflow: Workflow,
  job: WorkflowJob,
): Record<string, string> {
  return (job.permissions ?? workflow.permissions ?? {}) as Record<
    string,
    string
  >;
}

function scopesRequestedBy(workflow: Workflow): Record<string, string> {
  const requested: Record<string, string> = {};
  for (const job of Object.values(workflow.jobs)) {
    for (const [scope, level] of Object.entries(jobScopes(workflow, job))) {
      if (SCOPE_LEVELS[level] > SCOPE_LEVELS[requested[scope] ?? "none"]) {
        requested[scope] = level;
      }
    }
  }
  return requested;
}

describe("the website workflow", () => {
  const website = workflows.get("website.yml") as Workflow;
  const build = website.jobs.build;
  const verify = website.jobs.verify;
  const deploy = website.jobs.deploy;
  const scriptOf = (job: WorkflowJob) =>
    (job.steps ?? []).map((step) => step.run ?? "").join("\n");

  it("deploys from a job that holds only pages: write and id-token: write behind github-pages", () => {
    expect(deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(deploy.environment).toMatchObject({ name: "github-pages" });
    expect(deploy.needs).toEqual(["build", "verify"]);
    expect(deploy.steps?.map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/deploy-pages",
    ]);
    expect(deploy.steps?.some((step) => step.run !== undefined)).toBe(false);
  });

  it("builds from a validated stable tag on master, after checking install.sh against SHA256SUMS and its attestation", () => {
    const script = scriptOf(build);
    expect(build.permissions).toEqual({
      contents: "read",
      attestations: "read",
    });
    expect(script).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(script).toContain("git merge-base --is-ancestor");
    expect(stepUsing(build, "actions/checkout")?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    const attestation = script.indexOf("gh attestation verify install.sh");
    expect(script.indexOf("sha256sum -c -")).toBeGreaterThan(-1);
    expect(attestation).toBeGreaterThan(script.indexOf("sha256sum -c -"));
    expect(script).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"',
    );
    expect(script).toContain("--deny-self-hosted-runners");
    expect(script.indexOf("npm ci")).toBeGreaterThan(attestation);
    expect(script).toContain("npm ci --ignore-scripts");
    expect(script).toContain("npm ci --prefix website --ignore-scripts");
  });

  it("re-verifies the built site in a job that runs no npm, node or repository JavaScript", () => {
    const script = scriptOf(verify);
    expect(verify.needs).toBe("build");
    expect(verify.permissions).toEqual({
      contents: "read",
      attestations: "read",
    });
    expect(script).not.toMatch(/\b(npm|npx|node|tsx)\b/u);
    expect(script).toContain("tar --no-same-owner --no-same-permissions");
    expect(script).toContain("gh attestation verify");
    expect(script).toMatch(
      /sh scripts\/verify-site\.sh "\$RUNNER_TEMP\/site" .*SHA256SUMS"/su,
    );
  });

  it("runs manual deploys only from master", () => {
    expect(build).toMatchObject({
      if: "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/master'",
    });
  });

  it("is deployed by release.yml for stable tags only, and no other release job requests pages", () => {
    const release = workflows.get("release.yml") as Workflow;
    const websiteJob = release.jobs.website as WorkflowJob & { if?: string };
    expect(websiteJob.uses).toBe("./.github/workflows/website.yml");
    expect(websiteJob.if).toContain(
      "!contains(inputs.tag || github.ref_name, '-')",
    );
    expect(websiteJob.permissions).toEqual({
      contents: "read",
      pages: "write",
      "id-token": "write",
      attestations: "read",
    });
    const pagesJobs = Object.entries(release.jobs)
      .filter(([, job]) => "pages" in jobScopes(release, job))
      .map(([name]) => name);
    expect(pagesJobs).toEqual(["website"]);
  });

  it("every caller of a reusable workflow grants at least the scopes its jobs request", () => {
    const shortfalls = [...workflows].flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
        const callee = job.uses?.match(/^\.\/\.github\/workflows\/(.+)$/u)?.[1];
        if (!callee) return [];
        const granted = jobScopes(workflow, job);
        return Object.entries(
          scopesRequestedBy(workflows.get(callee) as Workflow),
        )
          .filter(
            ([scope, level]) =>
              SCOPE_LEVELS[granted[scope] ?? "none"] < SCOPE_LEVELS[level],
          )
          .map(
            ([scope, level]) => `${file}:${jobName} lacks ${scope}: ${level}`,
          );
      }),
    );
    expect(shortfalls).toEqual([]);
  });

  it("is built and verified by CI on every pull request", () => {
    const ci = workflows.get("ci.yml") as Workflow;
    const ciWebsite = ci.jobs.website as WorkflowJob & { if?: string };
    expect(ci.on?.pull_request).not.toHaveProperty("paths");
    expect(ciWebsite.if).toBe(
      "github.event_name != 'pull_request' || github.event.action != 'edited'",
    );
    expect(stepRunning(ciWebsite, /^npm run website:build$/u)).toBeDefined();
    expect(stepRunning(ciWebsite, /npm audit --prefix website/u)).toBeDefined();
  });
});
