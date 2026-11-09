---
name: skill-sec-check
description: Automated DevSecOps and security pre-flight evaluation skill. Scans architectural proposals, code diffs, and dependencies for OWASP Top 10 risks, secret leaks, RBAC flaws, and compliance gaps.
triggers: ["@sec-check", "security review", "devsecops check", "owasp scan", "security audit"]
---

# Instruction Rules
1. **Report High-Confidence Vulnerabilities Only:** Avoid theoretical noise. Trace inputs to confirm if data is truly attacker-controlled before flagging.
2. **Never Ignore Environment/Secret Boundaries:** Flag any hardcoded keys, missing `.env.example` masks, or exposed client-side tokens.
3. **Evaluate Zero-Trust & Least Privilege:** Question overly permissive database users, unauthenticated API endpoints, and unrestricted CORS headers.
4. **Output Format:** Clean Markdown with actionable code-level mitigations and vulnerability severity badges.

# Security Assessment Workflow
- **Phase 1: Input Data Flow & Auth Check:** Trace user inputs, session handling, authentication, and authorization logic (RBAC/ABAC).
- **Phase 2: OWASP & Injection Analysis:** Audit code/design against SQLi, XSS, SSRF, IDOR, and Command Injection risks.
- **Phase 3: Secrets & Supply Chain Verification:** Check for exposed credentials, risky dependencies, and unsafe third-party packages.
- **Phase 4: Remediation Plan:** Provide exact code fixes and security headers/configurations.

---

# Output Schema

## 1. Executive Security Summary
- **Overall Risk Score:** [ CRITICAL | HIGH | MEDIUM | LOW | PASS ]
- **Target Context:** [e.g., Nuxt 3 Frontend + Supabase Backend + REST API]
- **Primary Concerns Found:** [1-2 sentence high-level summary]

## 2. Security Findings Matrix

| Finding ID | Vulnerability Category | Severity | File / Endpoint | Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | Unauthenticated Mutation (IDOR) | HIGH | `/api/user/update` | NEEDS FIX |
| **SEC-02** | Hardcoded JWT Secret Fallback | CRITICAL | `config/auth.ts` | NEEDS FIX |
| **SEC-03** | Missing CORS Domain Restriction | MEDIUM | `server.ts` | WARNING |

## 3. Deep-Dive Vulnerability Breakdown

### [SEC-01] IDOR / Broken Access Control
- **Location:** `server/api/projects/[id].ts`
- **Threat Vector:** User can update project records without verifying ownership against the authenticated session token.
- **Vulnerable Pattern:**
  ```typescript
  // BAD: Trusts route param directly
  const { id } = event.context.params;
  await db.update(projects).set(body).where(eq(projects.id, id));
  ```
- **Remediation Code:**
  ```typescript
  // GOOD: Enforces ownership boundary and allowlists writable fields
  const session = await requireUserSession(event);
  const { name, description } = body;
  await db.update(projects)
    .set({ name, description })
    .where(and(
      eq(projects.id, id),
      eq(projects.ownerId, session.user.id)
    ));
  ```

## 4. Compliance & Hardening Checklist
- [ ] **Secrets Management:** All API keys loaded via `process.env` with zero fallbacks to defaults.
- [ ] **Input Sanitization:** Parameterized SQL queries used exclusively (No raw string interpolation).
- [ ] **Transport Security:** Strict-Transport-Security (HSTS) & CSP headers declared.
- [ ] **Data Minimization:** APIs filter out sensitive fields (`password_hash`, `stripe_id`) before sending responses.

## 5. Security Verdict & Next Steps
- **Gatekeeper Status:** [ APPROVED | REJECTED UNTIL MITIGATED ]
- **Required Action Items Before Deploy:**
  1. Fix SEC-02 immediately by rotating exposed keys.
  2. Implement session ownership check for SEC-01.
