const DENYLISTED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/,
  /(^|\/)id_rsa/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /\.local\.json$/,
];

const CREDENTIAL_KEY_PATTERN =
  /(?:^|[._-])(?:tokens?|secret|password|passwd|pwd|api[._-]?key|access[._-]?key|client[._-]?secret|auth|authorization|credentials?|private[._-]?key)(?:$|[._-])|_key$|^key$/i;

const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]+-----/;
const JWT_PATTERN =
  /^eyJ[A-Za-z0-9_-]+=*\.eyJ[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*$/;
const URL_WITH_CREDENTIALS_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i;

const HIGH_ENTROPY_MIN_LENGTH = 32;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;
const HIGH_ENTROPY_CHARSET = /^[A-Za-z0-9+/=_-]+$/;

export type RedactionReason =
  | "credential-key"
  | "pem"
  | "jwt"
  | "url-credentials"
  | "high-entropy";

export interface JsonRedactionResult {
  value: unknown;
  redactedPaths: string[];
}

export function isDenylistedPath(relativePath: string): boolean {
  return DENYLISTED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function shannonEntropyBitsPerChar(value: string): number {
  const characterCounts = new Map<string, number>();
  for (const character of value) {
    characterCounts.set(character, (characterCounts.get(character) ?? 0) + 1);
  }

  let bitsPerChar = 0;
  for (const count of characterCounts.values()) {
    const probability = count / value.length;
    bitsPerChar -= probability * Math.log2(probability);
  }
  return bitsPerChar;
}

function looksHighEntropy(value: string): boolean {
  return (
    value.length >= HIGH_ENTROPY_MIN_LENGTH &&
    HIGH_ENTROPY_CHARSET.test(value) &&
    shannonEntropyBitsPerChar(value) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR
  );
}

function classifyString(
  value: string,
  keyName: string | null,
): RedactionReason | null {
  if (keyName !== null && CREDENTIAL_KEY_PATTERN.test(keyName)) {
    return "credential-key";
  }
  if (PEM_PATTERN.test(value)) {
    return "pem";
  }
  if (JWT_PATTERN.test(value)) {
    return "jwt";
  }
  if (URL_WITH_CREDENTIALS_PATTERN.test(value)) {
    return "url-credentials";
  }
  if (looksHighEntropy(value)) {
    return "high-entropy";
  }
  return null;
}

export function redactJsonValue(input: unknown): JsonRedactionResult {
  const redactedPaths: string[] = [];

  const walk = (
    value: unknown,
    path: string,
    keyName: string | null,
  ): unknown => {
    if (typeof value === "string") {
      const reason = classifyString(value, keyName);
      if (reason === null) {
        return value;
      }
      redactedPaths.push(path);
      return `<redacted:${reason}>`;
    }

    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        walk(entry, `${path}[${index}]`, null),
      );
    }

    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([key, entryValue]) => [
            key,
            walk(entryValue, path === "" ? key : `${path}.${key}`, key),
          ],
        ),
      );
    }

    return value;
  };

  return { value: walk(input, "", null), redactedPaths };
}

const PEM_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const TOKEN_WRAPPER_PATTERN = /^([("'`[{<]*)(.*?)([)"'`\]}>,;.]*)$/s;
const KEY_SEPARATOR_PATTERN = /([A-Za-z0-9_.-]+)(["']?[=:])/g;
const KEY_PATH_SEPARATOR = /[/:?&]/;
const STANDALONE_SEPARATORS: ReadonlySet<string> = new Set(["=", ":"]);
const CAMEL_CASE_CREDENTIAL_SUFFIX =
  /(?:token|secret|password|passwd|apikey)$/i;
const AUTH_SCHEME_PATTERN = /^(?:bearer|basic)$/i;

function redactedMarker(reason: RedactionReason): string {
  return `<redacted:${reason}>`;
}

function namesCredentialKey(rawKey: string): boolean {
  const key = rawKey.replace(/^[-"']+/, "").replace(/["':]+$/, "");
  return (
    CREDENTIAL_KEY_PATTERN.test(key) ||
    CAMEL_CASE_CREDENTIAL_SUFFIX.test(key) ||
    AUTH_SCHEME_PATTERN.test(key)
  );
}

interface TokenRedaction {
  text: string;
  announcesSecret: boolean;
}

function redactKeyValue(token: string): TokenRedaction | null {
  for (const match of token.matchAll(KEY_SEPARATOR_PATTERN)) {
    if (!namesCredentialKey(match[1])) {
      continue;
    }
    const valueStart = (match.index ?? 0) + match[0].length;
    const upToValue = token.slice(0, valueStart);
    const value = token.slice(valueStart);
    if (value.length === 0 || AUTH_SCHEME_PATTERN.test(value)) {
      return { text: token, announcesSecret: true };
    }
    return {
      text: `${upToValue}${redactedMarker("credential-key")}`,
      announcesSecret: false,
    };
  }
  return null;
}

function redactToken(
  token: string,
  previousToken: string,
  secretWasAnnounced: boolean,
): TokenRedaction {
  const [, prefix, core, suffix] = TOKEN_WRAPPER_PATTERN.exec(
    token,
  ) as RegExpExecArray;
  if (AUTH_SCHEME_PATTERN.test(core)) {
    return { text: token, announcesSecret: true };
  }
  if (secretWasAnnounced) {
    return {
      text: `${prefix}${redactedMarker("credential-key")}${suffix}`,
      announcesSecret: false,
    };
  }
  if (STANDALONE_SEPARATORS.has(core)) {
    return {
      text: token,
      announcesSecret: namesCredentialKey(
        previousToken.split(KEY_PATH_SEPARATOR).at(-1) ?? "",
      ),
    };
  }
  const keyValue = redactKeyValue(token);
  if (keyValue !== null) {
    return keyValue;
  }
  if (core.startsWith("-") && namesCredentialKey(core)) {
    return { text: token, announcesSecret: true };
  }
  const reason = classifyString(core, null);
  return {
    text:
      reason === null ? token : `${prefix}${redactedMarker(reason)}${suffix}`,
    announcesSecret: false,
  };
}

export function redactSecretsInText(text: string): string {
  let previousToken = "";
  let secretWasAnnounced = false;
  return text
    .replace(PEM_BLOCK_PATTERN, redactedMarker("pem"))
    .split(/(\s+)/)
    .map((token) => {
      if (token.length === 0 || /^\s+$/.test(token)) {
        return token;
      }
      const redaction = redactToken(token, previousToken, secretWasAnnounced);
      previousToken = token;
      secretWasAnnounced = redaction.announcesSecret;
      return redaction.text;
    })
    .join("");
}
