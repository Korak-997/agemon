export const CODE_REVIEW_GRAPH_VERSION = "2.3.9";
export const CODE_REVIEW_GRAPH_PACKAGE_SPEC = `code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`;

export const ESSENTIALS_SKILLS_REPOSITORY_URL =
  "https://github.com/vercel-labs/agent-skills.git";
export const ESSENTIALS_SKILLS_COMMIT =
  "063bee94c3f4df8453406c830b0a7df0f2860278";

export const AGNIX_VERSION = "0.58.0";
export const AGNIX_RELEASE_ARCHIVE_SHA256 = {
  "agnix-x86_64-unknown-linux-gnu.tar.gz":
    "68cbf435c87e89319133cd4fd4b8b0c8b0763b17862f231bf495ccb9d8ee074b",
  "agnix-x86_64-unknown-linux-musl.tar.gz":
    "692d8e90017629e69d9256842ab010a6396affb1c482952f5988ade05fdbccd3",
  "agnix-aarch64-unknown-linux-gnu.tar.gz":
    "66b1ad951232b7f112e36b2fd8d7dae01ed3a89f84eee2152f5a2baf4dd8b0a7",
} as const;
