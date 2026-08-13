export interface WorkflowBundleEntry {
  id: string;
  filename: string;
  contents: string;
}

export const WORKFLOW_BUNDLE: WorkflowBundleEntry[] = [
  {
    id: "claude-code-security-review",
    filename: "claude-code-security-review.yml",
    contents: [
      "name: Claude Code Security Review",
      "",
      "on:",
      "  pull_request:",
      "",
      "permissions:",
      "  contents: read",
      "  security-events: write",
      "",
      "jobs:",
      "  security-review:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Checkout repository",
      "        uses: actions/checkout@v4",
      "",
      "      - name: Run Claude Code Security Review",
      "        uses: anthropics/claude-code-security-review@main",
      "",
    ].join("\n"),
  },
  {
    id: "code-review-graph-action",
    filename: "code-review-graph-action.yml",
    contents: [
      "name: Code Review Graph Action",
      "",
      "on:",
      "  pull_request:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  code-review-graph:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Checkout repository",
      "        uses: actions/checkout@v4",
      "",
      "      - name: Run Code Review Graph",
      "        uses: tirth8205/code-review-graph@main",
      "",
    ].join("\n"),
  },
];
