---
name: skill-headofit-audit
description: Evaluates SaaS tools, cloud infrastructure costs, self-hosted alternatives, vendor lock-in risks, and compliance readiness for Head of IT and IT Leadership decisions.
triggers: ["@vendor-audit", "head of it evaluation", "saas audit", "build vs buy", "infrastructure cost audit", "vendor evaluation"]
---

# Instruction Rules
1. **Multi-Vector Scoring:** Evaluate across 5 key pillars: Functional Fit, Technical/API Integration, Security & Compliance, Operational Overhead, and Total Cost of Ownership (TCO).
2. **Require Build vs. Buy Analysis:** Force explicit trade-off comparisons between managed SaaS, open-source/self-hosted (e.g., Coolify/Docker), and custom builds.
3. **Flag Lock-In & Portability Risks:** Always audit data export formats, vendor exit costs, and migration pathways.
4. **Output Format:** Clean Markdown featuring comparative scoring matrices, TCO projections, and strategic recommendations.

# Assessment Workflow
- **Phase 1: Need & Scope Definition:** Clarify business problem, usage scale, must-have constraints, and budget ceilings.
- **Phase 2: Build vs. Buy vs. Self-Host Analysis:** Evaluate managed options vs. self-hosted/open-source deployments.
- **Phase 3: Multi-Pillar Scoring & Security Pre-flight:** Audit SOC 2, GDPR, data residency, SLA guarantees, and API capabilities.
- **Phase 4: Financial TCO & Vendor Decision:** Calculate initial onboarding, subscription, maintenance, and exit costs over a 12–36 month horizon.

---

# Output Schema

# IT Infrastructure & Vendor Audit: [Vendor / Solution Name]

## 1. Executive Brief & Context
- **Evaluation Goal:** [e.g., Replacing managed DB platform with self-hosted PostgreSQL via Coolify]
- **Current Annual Spend / Cost:** [e.g., $18,000 / year]
- **Target Scale:** [e.g., 50 team members, 20 microservices, 99.9% uptime requirement]

---

## 2. Build vs. Buy vs. Self-Host Matrix

| Parameter | Managed SaaS | Self-Hosted / Homelab | Custom In-House |
| :--- | :--- | :--- | :--- |
| **Direct License Cost** | High ($1,500/mo) | Low (Infra bare-metal cost) | None |
| **Ops / Maintenance Effort** | Low (Vendor managed) | Medium-High (Internal Team) | High |
| **Data Control & Residency** | Moderate (Vendor Cloud) | Complete (Self-managed) | Complete |
| **Vendor Lock-in Risk** | High | Low | None |

---

## 3. Weighted Evaluation Scorecard

| Category | Weight | Score (1-5) | Key Observations |
| :--- | :--- | :--- | :--- |
| **Functional & Workflow Fit** | 30% | 4.5 / 5.0 | Meets 95% of operational requirements out of the box. |
| **Technical & API Capabilities** | 20% | 4.0 / 5.0 | REST & Webhook support present; missing GraphQL API. |
| **Security & Compliance** | 20% | 5.0 / 5.0 | GDPR compliant, SOC 2 Type II certified, isolated tenant DBs. |
| **Ops & Maintenance Overhead** | 15% | 3.5 / 5.0 | Requires internal team onboarding and backup orchestration. |
| **Financial & TCO Impact** | 15% | 4.0 / 5.0 | Payback period achieved within 6 months. |
| **Weighted Total** | **100%** | **4.28 / 5.0**| **RECOMMENDED** |

---

## 4. 3-Year Total Cost of Ownership (TCO) Projection

```
[Year 1 Setup & Licensing] ──> $12,000
[Year 2 Maintenance & Run]  ──> $8,500
[Year 3 Maintenance & Run]  ──> $8,500
Total Estimated 3-Year TCO:   $29,000 (35% savings vs incumbent)
```

---

## 5. Security, Risk & Exit Strategy
- **Security Check:** SOC 2 Type II verified, TLS 1.3 enforced, RBAC + SAML/SSO supported.
- **Vendor Lock-in Risk:** LOW. Native JSON/SQL export supported via API and CLI.
- **Recommended Next Steps:**
  1. Initiate 14-day technical pilot on staging infrastructure.
  2. Draft migration & rollback plan before contract finalization.
