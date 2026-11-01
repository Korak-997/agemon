export const FIRST_PARTY_SKILLS: readonly string[] = [
  "code-quality/agemon-house-rules",
  "commit/agemon-commit",
  "performance/agemon-performance",
  "team-lead/agemon-plan-rfc",
  "team-lead/prd-generator",
  "team-lead/skill-headofit-audit",
  "team-lead/skill-incident-rca",
  "team-lead/skill-meeting-lifecycle",
  "team-lead/skill-obsidian-vault-sync",
  "team-lead/skill-prd-decomposer",
  "team-lead/skill-sec-check",
  "team-lead/skill-task-extractor",
  "team-lead/skill-tech-spike",
  "team-lead/skill-techlead-reviewer",
];

export const LICENSE_TEXT_PHRASES: Record<string, readonly string[]> = {
  MIT: ["Permission is hereby granted, free of charge"],
  "Apache-2.0": ["Apache License", "Version 2.0"],
  "BSD-2-Clause": ["Redistribution and use in source and binary forms"],
  "BSD-3-Clause": ["Redistribution and use in source and binary forms"],
  ISC: ["Permission to use, copy, modify, and/or distribute"],
  "CC-BY-4.0": ["Attribution 4.0 International"],
};

const ALLOWED_LICENSE_IDS = Object.keys(LICENSE_TEXT_PHRASES);

export function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export interface SkillNotice {
  source: string;
  pathInSource: string;
  commit: string;
  retrieved: string;
  license: string;
}

const NOTICE_FIELDS: readonly {
  key: keyof SkillNotice;
  label: string;
  pattern: RegExp;
}[] = [
  {
    key: "source",
    label: "- Source: <https URL>",
    pattern: /^- Source: (https:\/\/\S+)$/u,
  },
  {
    key: "pathInSource",
    label: "- Path in source: <path>",
    pattern: /^- Path in source: (\S.*)$/u,
  },
  {
    key: "commit",
    label: "- Commit: <40-character commit SHA>",
    pattern: /^- Commit: ([0-9a-f]{40})$/u,
  },
  {
    key: "retrieved",
    label: "- Retrieved: <YYYY-MM-DD>",
    pattern: /^- Retrieved: (\d{4}-\d{2}-\d{2})$/u,
  },
  {
    key: "license",
    label: `- License: <${ALLOWED_LICENSE_IDS.slice(0, -1).join(", ")} or ${ALLOWED_LICENSE_IDS.at(-1)}>`,
    pattern: new RegExp(
      `^- License: (${ALLOWED_LICENSE_IDS.map(escapeForPattern).join("|")})(?:\\s.*)?$`,
      "u",
    ),
  },
];

export interface ParsedNotice {
  notice?: SkillNotice;
  fieldsNotExactlyOnce: string[];
  license?: string;
}

export function parseNotice(text: string): ParsedNotice {
  const lines = text.split(/\r?\n/u);
  const values: Partial<SkillNotice> = {};
  const fieldsNotExactlyOnce: string[] = [];
  for (const field of NOTICE_FIELDS) {
    const matches = lines.flatMap((line) => {
      const match = field.pattern.exec(line);
      return match ? [match[1]] : [];
    });
    if (matches.length === 1) {
      values[field.key] = matches[0];
    } else {
      fieldsNotExactlyOnce.push(field.label);
    }
  }
  return {
    notice:
      fieldsNotExactlyOnce.length === 0 ? (values as SkillNotice) : undefined,
    fieldsNotExactlyOnce,
    license: values.license,
  };
}
