import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyContentSecurityPolicy,
  CspError,
  findSvgProblems,
} from "../../../scripts/site-csp/policy.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const ORIGIN = "https://agemon.example";
const POLICY = readFileSync(
  resolve(REPOSITORY_ROOT, "website/csp-policy.txt"),
  "utf8",
).trim();

function page(head: string, body = ""): string {
  return `<!DOCTYPE html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
}

function apply(html: string): string {
  return applyContentSecurityPolicy(html, "page.html", POLICY, ORIGIN);
}

function cspOf(html: string): string {
  return (
    /<head><meta http-equiv="content-security-policy" content="([^"]*)">/u.exec(
      html,
    )?.[1] ?? ""
  );
}

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("applyContentSecurityPolicy", () => {
  it("puts the policy first in <head> with a hash for every inline script", () => {
    const first = "window.a = 1;";
    const second = "console.log('b');";
    const html = apply(
      page(
        `<meta charset="utf-8"><script>${first}</script>`,
        `<script type="module">${second}</script><script src="/_astro/x.js"></script>`,
      ),
    );
    const csp = cspOf(html);
    expect(csp).toContain(sha256(first));
    expect(csp).toContain(sha256(second));
    expect(csp.replace(/ 'sha256-[^']*'/gu, "")).toBe(POLICY);
    expect(html).toContain(`<script>${first}</script>`);
  });

  it("leaves links to other sites and same-site resources alone", () => {
    expect(() =>
      apply(
        page(
          `<link rel="canonical" href="${ORIGIN}/x/"><link rel="stylesheet" href="/_astro/a.css">`,
          '<a href="https://github.com/x">x</a><img src="/a.svg"><img src="data:image/png;base64,AA==">',
        ),
      ),
    ).not.toThrow();
  });

  it.each([
    ["an event handler", '<button onclick="x()">x</button>'],
    ["a javascript: URL", '<a href="javascript:alert(1)">x</a>'],
    ["an off-site script", '<script src="https://cdn.example/x.js"></script>'],
    [
      "a protocol-relative script",
      '<script src="//cdn.example/x.js"></script>',
    ],
    ["an off-site image", '<img src="https://img.example/x.png">'],
    [
      "an off-site SVG href",
      '<svg><use href="https://x.example/a.svg#i"></use></svg>',
    ],
    [
      "an off-site SVG xlink:href",
      '<svg><image xlink:href="https://x.example/a.png"></image></svg>',
    ],
    ["a javascript: URL with a tab", '<a href="java&#9;script:alert(1)">x</a>'],
    [
      "a javascript: URL after a control character",
      '<a href="&#1;javascript:alert(1)">x</a>',
    ],
    [
      "an off-site srcset candidate",
      '<img srcset="/a.png 1x, https://evil.example/x.png 2x">',
    ],
    [
      "an off-site style url()",
      '<div style="background:url(https://evil.example/x.png)"></div>',
    ],
    [
      "an off-site form action",
      '<form action="https://evil.example/collect"></form>',
    ],
    [
      "a meta refresh inside noscript",
      '<noscript><meta http-equiv="refresh" content="0;url=https://evil.example/"></noscript>',
    ],
    ["an iframe", '<iframe src="/x"></iframe>'],
    ["an object", '<object data="/x"></object>'],
    ["an embed", '<embed src="/x">'],
    ["a JSON script", '<script type="application/ld+json">{}</script>'],
    ["a classic script type", '<script type="text/javascript">x</script>'],
  ])("rejects %s", (_name, body) => {
    expect(() => apply(page("", body))).toThrow(CspError);
  });

  it.each([
    ["a <base>", '<base href="/">'],
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=/x">'],
    [
      "an existing CSP",
      '<meta http-equiv="Content-Security-Policy" content="default-src *">',
    ],
    [
      "an off-site stylesheet",
      '<link rel="stylesheet" href="https://x.example/a.css">',
    ],
    ["an off-site icon", '<link rel="icon" href="https://x.example/a.ico">'],
    [
      "an off-site prefetch",
      '<link rel="prefetch" href="https://x.example/a">',
    ],
    [
      "an off-site dns-prefetch",
      '<link rel="dns-prefetch" href="https://x.example">',
    ],
  ])("rejects %s in <head>", (_name, head) => {
    expect(() => apply(page(head))).toThrow(CspError);
  });
});

describe("findSvgProblems", () => {
  it("accepts a plain brand SVG", () => {
    const logo = readFileSync(
      resolve(REPOSITORY_ROOT, "website/public/favicon.svg"),
      "utf8",
    );
    expect(findSvgProblems(logo, "favicon.svg")).toEqual([]);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "<svg><foreignObject><div></div></foreignObject></svg>",
    '<svg onload="x()"></svg>',
    '<svg><a href="javascript:alert(1)"></a></svg>',
    '<svg><image href="https://x.example/a.png"/></svg>',
    '<svg><style>@import "https://x.example/a.css";</style></svg>',
    '<svg><rect style="fill:url(https://x.example/a#p)"/></svg>',
    '<svg><a href="java&#x73;cript:alert(1)"><text>x</text></a></svg>',
    '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
  ])("rejects %s", (svg) => {
    expect(findSvgProblems(svg, "x.svg")).not.toEqual([]);
  });
});
