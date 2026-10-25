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
export const AGNIX_NPM_TARBALL = {
  url: `https://registry.npmjs.org/agnix/-/agnix-${AGNIX_VERSION}.tgz`,
  integrity:
    "sha512-DpGdAmG66EmwNSlX+JXiEUbCL+dxbOiDAjzniHgafFbfDfQKYGHyEEVBT1JcKAMPVapM3U2jCU1U+4UCOnT/TA==",
} as const;
export const AGNIX_PACKAGE_FILE_SHA256 = {
  "package.json":
    "c214b20e9ba469c9fb318937a5aa2efbddff057797fd77eda49eefcdb869dd8b",
  "bin/agnix":
    "34a7b789cea9872deb3c81fde838c003a3b4366f3924d06e9deb3cccc60228af",
} as const;
export const AGNIX_BINARY_SHA256 = [
  "d220619c26e4b6f8448bad36816608dfeca0ae2b7c3153ea1d772d485eec6bc9",
  "b4a3c1c630e36dbc3227da82a14b5b055e3add70f5d8384675fbab8e4ae317e6",
  "fca697c810e5ea6598c48377171ad57fdae8b8b82ac9f33c6e6d1c7338ec2987",
] as const;
