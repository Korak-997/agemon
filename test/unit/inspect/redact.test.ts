import { describe, expect, it } from "vitest";
import {
  isDenylistedPath,
  redactJsonValue,
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
