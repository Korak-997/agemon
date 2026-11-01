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
      "id_ed25519",
      ".ssh/id_ecdsa",
      "certs/server.key",
      "certs/client.p12",
      "certs/client.pfx",
      "certs/SERVER.KEY",
      "config/SERVICE.PEM",
      "ID_RSA",
      ".pypirc",
      ".aws/credentials",
      "home/.aws/credentials",
      ".docker/config.json",
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

  it("redacts array elements under a credential-shaped key", () => {
    const { value, redactedPaths } = redactJsonValue({
      tokens: ["first", "second"],
      auth: [["nested"]],
    });

    expect(value).toEqual({
      tokens: ["<redacted:credential-key>", "<redacted:credential-key>"],
      auth: [["<redacted:credential-key>"]],
    });
    expect(redactedPaths).toEqual(["tokens[0]", "tokens[1]", "auth[0][0]"]);
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
    ["a quoted key=value", "token='abc'", "token='<redacted:credential-key>'"],
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
      '{"token":"<redacted:credential-key>"}',
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

  it("redacts lowercase PEM blocks", () => {
    expect(
      redactSecretsInText(
        "a\n-----begin rsa private key-----\nMIIE\n-----end rsa private key-----\nb",
      ),
    ).toBe("a\n<redacted:pem>\nb");
  });

  it("redacts SSH2 key blocks with four dashes and spaces", () => {
    expect(
      redactSecretsInText(
        "---- BEGIN SSH2 PUBLIC KEY ----\nAAAAB3Nza\n---- END SSH2 PUBLIC KEY ----",
      ),
    ).toBe("<redacted:pem>");
  });

  it("redacts a PEM tail that has no BEGIN line", () => {
    expect(
      redactSecretsInText(
        "MIIEowIBAAKCAQEA\nq2x9Zs=\n-----END RSA PRIVATE KEY-----\nnext",
      ),
    ).toBe("<redacted:pem>\nnext");
  });

  it("keeps 'Token' and redacts its value after an Authorization key", () => {
    expect(redactSecretsInText("Authorization: Token abc123")).toBe(
      "Authorization: Token <redacted:credential-key>",
    );
  });

  it("leaves the word token in prose alone", () => {
    expect(redactSecretsInText("invalid token supplied")).toBe(
      "invalid token supplied",
    );
  });

  it("keeps a non-credential key and redacts only the credential URL", () => {
    expect(redactSecretsInText("url=https://user:pass@host/x")).toBe(
      "url=<redacted:url-credentials>",
    );
  });

  it("redacts camelCase credential keys in text", () => {
    expect(redactSecretsInText("secretKey=abc apiToken: xyz")).toBe(
      "secretKey=<redacted:credential-key> apiToken: <redacted:credential-key>",
    );
  });
});

describe("redactJsonValue — key classification and nesting", () => {
  it("redacts camelCase credential keys", () => {
    const { value } = redactJsonValue({
      accessToken: "abc123short",
      githubToken: "ghp_short1",
      secretKey: "s",
      clientSecret: "c",
      privateKey: "p",
    });

    expect(Object.values(value as Record<string, string>)).toEqual(
      Array(5).fill("<redacted:credential-key>"),
    );
  });

  it("leaves tokenizer, authorName and keyboard alone", () => {
    const input = { tokenizer: "bpe", authorName: "me", keyboard: "us" };

    expect(redactJsonValue(input).value).toEqual(input);
  });

  it("redacts strings in objects nested under a credential key", () => {
    const { value, redactedPaths } = redactJsonValue({
      tokens: [{ value: "v" }],
      credentials: { user: "u", pass: "p" },
      auth: { type: "bearer", retries: 3, enabled: true },
    });

    expect(value).toEqual({
      tokens: [{ value: "<redacted:credential-key>" }],
      credentials: {
        user: "<redacted:credential-key>",
        pass: "<redacted:credential-key>",
      },
      auth: { type: "<redacted:credential-key>", retries: 3, enabled: true },
    });
    expect(redactedPaths).toEqual([
      "tokens[0].value",
      "credentials.user",
      "credentials.pass",
      "auth.type",
    ]);
  });

  it("flags a lowercase PEM header in a value", () => {
    expect(
      redactJsonValue({ cert: "-----begin certificate-----\nabc" }).value,
    ).toEqual({ cert: "<redacted:pem>" });
  });
});

describe("isDenylistedPath — more credential files", () => {
  it("covers kube config, pgpass, ppk, jks, keystore, credentials.json and other CLI token files", () => {
    for (const path of [
      ".kube/config",
      "home/.kube/config",
      ".pgpass",
      "keys/server.ppk",
      "keys/app.jks",
      "keys/app.KEYSTORE",
      "credentials.json",
      "gcp/credentials.json",
      ".config/gh/hosts.yml",
      ".vault-token",
      "credentials.tfrc.json",
      "application_default_credentials.json",
      ".azure/accessTokens.json",
      "vault.kdbx",
    ]) {
      expect(isDenylistedPath(path), path).toBe(true);
    }
  });

  it("does not match lookalike documentation files", () => {
    for (const path of [
      "kubeconfig.md",
      "my-credentials.json.md",
      "docs/pgpass.md",
    ]) {
      expect(isDenylistedPath(path), path).toBe(false);
    }
  });

  it("covers gcloud, GnuPG, Terraform CLI and service-account key files", () => {
    for (const path of [
      ".config/gcloud/credentials.db",
      ".gnupg/private-keys-v1.d/key.key",
      ".terraformrc",
      "keys/prod-service-account.json",
      "my_service_account_key.json",
    ]) {
      expect(isDenylistedPath(path), path).toBe(true);
    }
  });
});

describe("redaction — result-gate follow-ups", () => {
  it("keeps the all-lowercase suffix rule in text and JSON", () => {
    expect(redactSecretsInText("accesstoken=short1")).toBe(
      "accesstoken=<redacted:credential-key>",
    );
    expect(redactJsonValue({ myapikey: "x" }).value).toEqual({
      myapikey: "<redacted:credential-key>",
    });
  });

  it("redacts a PEM tail with CRLF line ends", () => {
    expect(
      redactSecretsInText(
        "MIIEowIBAAK\r\nq2x9Zs=\r\n-----END RSA PRIVATE KEY-----",
      ),
    ).toBe("<redacted:pem>");
  });

  it("redacts 300 KB of raw single-token text in bounded time", () => {
    const startedAt = Date.now();

    redactSecretsInText("b".repeat(300 * 1024));

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("classifies a 300 KB JSON string in bounded time", () => {
    const startedAt = Date.now();

    redactJsonValue({ note: "a.".repeat(150 * 1024) });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
