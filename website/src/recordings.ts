export const RECORDING_WIDTH = 1280;
export const RECORDING_HEIGHT = 720;

export interface Recording {
  name: string;
  title: string;
  description: string;
}

export const ROUNDTRIP: Recording = {
  name: "roundtrip",
  title: "agemon · roundtrip",
  description:
    "agemon installs the essentials bundle with --yes, agemon nuke removes everything it added, and git status --ignored shows the repository exactly as it was.",
};

export const PLAN_AND_CONSENT: Recording = {
  name: "plan-and-consent",
  title: "plan and consent",
  description:
    "agemon asks for consent at three gates — install tooling, register the background service, write the instruction files — shows the diff for the instruction files, and applies only after every gate is answered.",
};

export const FAILURE_AND_ROLLBACK: Recording = {
  name: "failure-and-rollback",
  title: "failure and rollback",
  description:
    "agemon plans a run, the repository is made read-only, and applying the plan fails with a permission error; agemon rolls the whole run back and git status shows nothing changed.",
};

export const RECORDINGS = [ROUNDTRIP, PLAN_AND_CONSENT, FAILURE_AND_ROLLBACK];
