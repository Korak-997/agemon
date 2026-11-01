const DENYLISTED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/i,
  /(^|\/)id_(?:rsa|ed25519|ecdsa|dsa)/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /\.local\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.pgpass$/,
  /\.ppk$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /(^|\/)credentials\.json$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/,
  /(^|\/)\.vault-token$/,
  /(^|\/)credentials\.tfrc\.json$/,
  /(^|\/)application_default_credentials\.json$/,
  /(^|\/)\.azure\/accessTokens\.json$/,
  /\.kdbx$/i,
  /(^|\/)\.config\/gcloud\/credentials\.db$/,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.terraformrc$/,
  /(^|\/)[^/]*service[-_]account[^/]*\.json$/i,
];

const CREDENTIAL_KEY_PATTERN =
  /(?:^|[._-])(?:tokens?|secret|password|passwd|pwd|api[._-]?key|access[._-]?key|client[._-]?secret|auth|authorization|credentials?|private[._-]?key)(?:$|[._-])|_key$|^key$/i;
const CAMEL_CASE_BOUNDARY = /([a-z0-9])([A-Z])/g;
const CONCATENATED_CREDENTIAL_SUFFIX =
  /(?:token|secret|password|passwd|apikey)$/i;

const PEM_DASHES = "-{4,5}";
const PEM_LABEL = "[A-Z0-9 ]+";
const PEM_BEGIN = `${PEM_DASHES} ?BEGIN ${PEM_LABEL}${PEM_DASHES}`;
const PEM_END = `${PEM_DASHES} ?END ${PEM_LABEL}${PEM_DASHES}`;
const PEM_PATTERN = new RegExp(PEM_BEGIN, "i");
const JWT_PATTERN =
  /^eyJ[A-Za-z0-9_-]+=*\.eyJ[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]+=*$/;
const URL_WITH_CREDENTIALS_PATTERN =
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]+:[^/\s:@]+@/i;

export const MAX_REDACTED_LINE_CHARACTERS = 4096;

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

function stripKeyDecoration(rawKey: string): string {
  return rawKey.replace(/^[-"']+/, "").replace(/["':]+$/, "");
}

function namesCredentialKey(rawKey: string): boolean {
  const key = stripKeyDecoration(rawKey);
  return (
    CREDENTIAL_KEY_PATTERN.test(key.replace(CAMEL_CASE_BOUNDARY, "$1_$2")) ||
    CONCATENATED_CREDENTIAL_SUFFIX.test(key)
  );
}

function classifyString(value: string): RedactionReason | null {
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
    insideCredentialKey: boolean,
  ): unknown => {
    if (typeof value === "string") {
      const reason = insideCredentialKey
        ? "credential-key"
        : classifyString(value.slice(0, MAX_REDACTED_LINE_CHARACTERS));
      if (reason === null) {
        return value;
      }
      redactedPaths.push(path);
      return redactedMarker(reason);
    }

    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        walk(entry, `${path}[${index}]`, insideCredentialKey),
      );
    }

    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([key, entryValue]) => [
            key,
            walk(
              entryValue,
              path === "" ? key : `${path}.${key}`,
              insideCredentialKey || namesCredentialKey(key),
            ),
          ],
        ),
      );
    }

    return value;
  };

  return { value: walk(input, "", false), redactedPaths };
}

const PEM_BLOCK_PATTERN = new RegExp(
  `${PEM_BEGIN}[\\s\\S]*?(?:${PEM_END}|$)`,
  "gi",
);
const PEM_TAIL_WITHOUT_BEGIN_PATTERN = new RegExp(
  `^(?:[A-Za-z0-9+/=]+\\r?\\n)*${PEM_END}`,
  "gim",
);
const TOKEN_WRAPPER_PATTERN = /^([("'`[{<]*)(.*?)([)"'`\]}>,;.]*)$/s;
const KEY_SEPARATOR_PATTERN = /([A-Za-z0-9_.-]+)(["']?[=:])/g;
const ASSIGNMENT_PATTERN = /^([A-Za-z0-9_.-]+=)(.+)$/s;
const KEY_PATH_SEPARATOR = /[/:?&]/;
const STANDALONE_SEPARATORS: ReadonlySet<string> = new Set(["=", ":"]);
const AUTH_SCHEME_PATTERN = /^(?:bearer|basic)$/i;
const AUTHORIZATION_TOKEN_SCHEME = /^token$/i;

function redactedMarker(reason: RedactionReason): string {
  return `<redacted:${reason}>`;
}

function announcesSecretInText(rawKey: string): boolean {
  return (
    namesCredentialKey(rawKey) ||
    AUTH_SCHEME_PATTERN.test(stripKeyDecoration(rawKey))
  );
}

interface TokenRedaction {
  text: string;
  announcesSecret: boolean;
}

function redactKeyValue(token: string): TokenRedaction | null {
  for (const match of token.matchAll(KEY_SEPARATOR_PATTERN)) {
    if (!announcesSecretInText(match[1])) {
      continue;
    }
    const valueStart = (match.index ?? 0) + match[0].length;
    const upToValue = token.slice(0, valueStart);
    const [, valuePrefix, value, valueSuffix] = TOKEN_WRAPPER_PATTERN.exec(
      token.slice(valueStart),
    ) as RegExpExecArray;
    if (value.length === 0 || AUTH_SCHEME_PATTERN.test(value)) {
      return { text: token, announcesSecret: true };
    }
    return {
      text: `${upToValue}${valuePrefix}${redactedMarker("credential-key")}${valueSuffix}`,
      announcesSecret: false,
    };
  }
  return null;
}

function redactAssignedValue(core: string): string | null {
  const assignment = ASSIGNMENT_PATTERN.exec(core);
  if (assignment === null) {
    return null;
  }
  const reason = classifyString(assignment[2]);
  return reason === null ? null : `${assignment[1]}${redactedMarker(reason)}`;
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
    if (AUTHORIZATION_TOKEN_SCHEME.test(core)) {
      return { text: token, announcesSecret: true };
    }
    return {
      text: `${prefix}${redactedMarker("credential-key")}${suffix}`,
      announcesSecret: false,
    };
  }
  if (STANDALONE_SEPARATORS.has(core)) {
    return {
      text: token,
      announcesSecret: announcesSecretInText(
        previousToken.split(KEY_PATH_SEPARATOR).at(-1) ?? "",
      ),
    };
  }
  const keyValue = redactKeyValue(token);
  if (keyValue !== null) {
    return keyValue;
  }
  if (core.startsWith("-") && announcesSecretInText(core)) {
    return { text: token, announcesSecret: true };
  }
  const redactedAssignment = redactAssignedValue(core);
  if (redactedAssignment !== null) {
    return {
      text: `${prefix}${redactedAssignment}${suffix}`,
      announcesSecret: false,
    };
  }
  const reason = classifyString(core);
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
    .split("\n")
    .map((line) => line.slice(0, MAX_REDACTED_LINE_CHARACTERS))
    .join("\n")
    .replace(PEM_BLOCK_PATTERN, redactedMarker("pem"))
    .replace(PEM_TAIL_WITHOUT_BEGIN_PATTERN, redactedMarker("pem"))
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
