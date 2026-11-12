export const CODE_REVIEW_GRAPH_VERSION = "2.3.9";
export const CODE_REVIEW_GRAPH_PACKAGE_SPEC = `code-review-graph==${CODE_REVIEW_GRAPH_VERSION}`;

export const AGNIX_VERSION = "0.58.0";
export const AGNIX_RELEASE_ARCHIVE_SHA256 = {
  "agnix-x86_64-unknown-linux-gnu.tar.gz":
    "68cbf435c87e89319133cd4fd4b8b0c8b0763b17862f231bf495ccb9d8ee074b",
  "agnix-x86_64-unknown-linux-musl.tar.gz":
    "692d8e90017629e69d9256842ab010a6396affb1c482952f5988ade05fdbccd3",
  "agnix-aarch64-unknown-linux-gnu.tar.gz":
    "66b1ad951232b7f112e36b2fd8d7dae01ed3a89f84eee2152f5a2baf4dd8b0a7",
  "agnix-aarch64-apple-darwin.tar.gz":
    "a0585c5ad000d8c6861f545ff55d0a7b09460653cd29e56c15675bb9e6e62fe7",
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
  "d9dc2071417d9f5c288e87031f861eba8689586f8f6df9c30a2a21348ceba598",
] as const;

export const GITLEAKS_VERSION = "8.30.1";
export const GITLEAKS_RELEASE_ARCHIVE_SHA256 = {
  "gitleaks_8.30.1_linux_x64.tar.gz":
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  "gitleaks_8.30.1_linux_arm64.tar.gz":
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  "gitleaks_8.30.1_darwin_arm64.tar.gz":
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  "gitleaks_8.30.1_darwin_x64.tar.gz":
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
} as const;

export const AST_GREP_VERSION = "0.51.1";
export const AST_GREP_ARCHIVE_SHA256 = {
  "@ast-grep/cli-linux-x64-gnu":
    "617128eff67d49d709ded54d9c089371d882ce11628c6d79c00add00aa38cb3c",
  "@ast-grep/cli-linux-arm64-gnu":
    "1b68729c99bf026f5b8deec3ebd52f2f721a157a45bb4375c61ca5acaaad13d5",
  "@ast-grep/cli-darwin-arm64":
    "9d2c21843cebaa11afff8a249703b04a764ef1e03c9f795447e83bec5e34230b",
  "@ast-grep/cli-darwin-x64":
    "bd227e54be0dd7f3f3543aa287ec90bed598f1e5e0e34102b371fca2ba1451ba",
} as const;
