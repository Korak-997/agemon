import { describe, expect, it } from "vitest";
import {
  isDenylistedPath,
  redactJsonValue,
  redactSecretsInText,
} from "../../../src/inspect/redact.js";

describe("isDenylistedPath", () => {
  it("flags private credential and local-config files", () => {
    for (const path of [
      ".env",
      ".env.local",
      "config/service.pem",
      "id_rsa",
      ".npmrc",
      ".netrc",
      ".git-credentials",
      ".claude/settings.local.json",
    ]) {
      expect(isDenylistedPath(path), path).toBe(true);
    }
  });

  it("allows agemon's supported structured-config surface", () => {
    for (const path of [
      ".mcp.json",
      ".claude/settings.json",
      ".gemini/settings.json",
    ]) {
      expect(isDenylistedPath(path), path).toBe(false);
    }
  });
});

describe("redactJsonValue", () => {
  it("redacts credential-shaped keys regardless of value", () => {
    const { value, redactedPaths } = redactJsonValue({
      mcpServers: {
        example: {
          command: "npx",
          env: { API_KEY: "abc", authorization: "Bearer xyz" },
          token: "short",
        },
      },
    });

    expect(value).toEqual({
      mcpServers: {
        example: {
          command: "npx",
          env: {
            API_KEY: "<redacted:credential-key>",
            authorization: "<redacted:credential-key>",
          },
          token: "<redacted:credential-key>",
        },
      },
    });
    expect(redactedPaths).toEqual([
      "mcpServers.example.env.API_KEY",
      "mcpServers.example.env.authorization",
      "mcpServers.example.token",
    ]);
  });

  it("redacts credential-shaped values under innocuous keys", () => {
    const { value } = redactJsonValue({
      note: "-----BEGIN PRIVATE KEY-----AAAA",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3ZhbHVl",
      endpoint: "https://user:s3cr3t@example.com/mcp",
      blob: "AbcdEfghIjklMnopQrstUvwx0123456789+/AbcdEfgh",
    });

    expect(value).toEqual({
      note: "<redacted:pem>",
      jwt: "<redacted:jwt>",
      endpoint: "<redacted:url-credentials>",
      blob: "<redacted:high-entropy>",
    });
  });

  it("leaves ordinary values untouched", () => {
    const input = {
      command: "npx",
      args: ["-y", "server"],
      port: 3000,
      enabled: true,
      url: "https://example.com/mcp",
    };
    const { value, redactedPaths } = redactJsonValue(input);

    expect(value).toEqual(input);
    expect(redactedPaths).toEqual([]);
  });
});

describe("redactSecretsInText", () => {
  const JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const TOKEN = "ghp_9aZx3Qw7Lp2Rt6Yb8Nc4Vd1Ks5Mf0Hj3Ge7Ui";

  it.each([
    ["a quoted, punctuated token", `"${TOKEN}",`, `"<redacted:high-entropy>",`],
    ["a bracketed token", `(${TOKEN})`, "(<redacted:high-entropy>)"],
    ["a JWT", `got ${JWT}`, "got <redacted:jwt>"],
    [
      "URL credentials",
      "fetch https://bob:hunter2@registry.example.com/x",
      "fetch <redacted:url-credentials>",
    ],
    ["key=value", "api_key=short123", "api_key=<redacted:credential-key>"],
    ["a quoted key=value", "token='abc'", "token=<redacted:credential-key>"],
    ["key: value", "password: hunter2", "password: <redacted:credential-key>"],
    [
      "an Authorization header",
      "Authorization: Bearer abc.def",
      "Authorization: Bearer <redacted:credential-key>",
    ],
    [
      "a --token argument",
      "--token abc123",
      "--token <redacted:credential-key>",
    ],
    [
      "a --password argument",
      "--password=abc123",
      "--password=<redacted:credential-key>",
    ],
    [
      "an npm registry auth token",
      "//registry.npmjs.org/:_authToken=npm_abcd1234",
      "//registry.npmjs.org/:_authToken=<redacted:credential-key>",
    ],
    [
      "a spaced npm auth token",
      "_authToken = npm_abcd1234",
      "_authToken = <redacted:credential-key>",
    ],
    [
      "a spaced npm registry auth token",
      "//registry.npmjs.org/:_authToken = npm_abcd1234",
      "//registry.npmjs.org/:_authToken = <redacted:credential-key>",
    ],
    [
      "a camelCase key",
      "accessToken=abc",
      "accessToken=<redacted:credential-key>",
    ],
    [
      "a camelCase label",
      "--authToken abc",
      "--authToken <redacted:credential-key>",
    ],
    [
      "a token in a URL query",
      "https://example.com/hook?token=abc",
      "https://example.com/hook?token=<redacted:credential-key>",
    ],
    [
      "a JSON-style key",
      '{"password": "hunter2"}',
      '{"password": "<redacted:credential-key>"}',
    ],
    [
      "a compact JSON key",
      '{"token":"hunter2"}',
      '{"token":<redacted:credential-key>',
    ],
    [
      "a colon-joined key",
      "password:hunter2",
      "password:<redacted:credential-key>",
    ],
    [
      "a spaced colon",
      "password : hunter2",
      "password : <redacted:credential-key>",
    ],
    [
      "an unspaced Authorization header",
      "Authorization:Bearer abc",
      "Authorization:Bearer <redacted:credential-key>",
    ],
    ["a scheme-joined token", "Bearer:abc", "Bearer:<redacted:credential-key>"],
  ])("redacts %s", (_label, input, expected) => {
    expect(redactSecretsInText(input)).toBe(expected);
  });

  it("redacts a whole PEM block across lines, including its short last line", () => {
    const pem =
      "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc=\n-----END PRIVATE KEY-----\nafter";

    expect(redactSecretsInText(pem)).toBe("before\n<redacted:pem>\nafter");
  });

  it("redacts an unterminated PEM block to the end of the text", () => {
    expect(
      redactSecretsInText("ok\n-----BEGIN RSA PRIVATE KEY-----\nabc\ndef"),
    ).toBe("ok\n<redacted:pem>");
  });

  it("leaves ordinary output untouched, keeping its whitespace", () => {
    const output =
      "added 3 packages in 2s\n  installed  code-review-graph==2.1.0\n\tdone";

    expect(redactSecretsInText(output)).toBe(output);
  });
});
