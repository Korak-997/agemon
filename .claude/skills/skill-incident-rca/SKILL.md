---
name: skill-incident-rca
description: Blameless Root Cause Analysis (RCA) and Post-Mortem framework for production outages, regressions, and critical incidents. Uses the 5 Whys and Causal Chain analysis to convert incident logs into durable preventative actions.
triggers: ["@incident-rca", "post-mortem", "root cause analysis", "incident report", "outage rca", "rca"]
---

# Instruction Rules
1. **Enforce Blameless Culture:** Focus strictly on systemic vulnerabilities, process gaps, and missing safeguards. Never attribute failures to individual human error.
2. **5 Whys Deep-Dive:** Chain every surface symptom down through at least 5 levels of "Why?" until reaching an actionable architectural or process gap. If evidence runs out before reaching level 5, mark the chain `UNKNOWN — insufficient evidence` at that point rather than inventing an unsupported cause.
3. **Quantify Impact:** Explicitly quantify outage duration, user blast radius, data loss, and SLA breach metrics. Mark any metric not available in the evidence as `UNKNOWN` rather than estimating.
4. **Action Item Discipline:** Output clear action items with specific owners, category tags, and due dates. Avoid vague terms like "improve testing".

# Execution Workflow
- **Step 1: Timeline Reconstruction:** Map events chronologically (Start $\rightarrow$ Detection $\rightarrow$ Triage $\rightarrow$ Mitigation $\rightarrow$ Resolution).
- **Step 2: Root Cause & 5 Whys Analysis:** Dig past immediate triggers (e.g., "database lock") to underlying root causes (e.g., "missing connection pool timeouts").
- **Step 3: Contributing Factors:** Identify monitoring gaps, missing runbooks, or testing blind spots that aggravated the issue.
- **Step 4: Preventative Action Matrix:** Create owned, closed-form engineering tasks.

---

# Output Schema

# Post-Mortem: [Incident Title / Outage Name]

## 1. Executive Summary
- **Incident Date:** {{YYYY-MM-DD}}
- **Severity Level:** [ SEV-1 | SEV-2 | SEV-3 ]
- **Time to Detect (TTD):** [e.g., 8 minutes]
- **Time to Resolve (TTR):** [e.g., 42 minutes]
- **Blast Radius:** [e.g., 15% of active API traffic received HTTP 500 errors]
- **Summary:** [3-sentence executive overview of what failed, impact, and mitigation]

---

## 2. Chronological Timeline
| Timestamp (UTC) | Event Phase | Description & Findings | Source / Evidence |
| :--- | :--- | :--- | :--- |
| **14:02** | Incident Start | Spike in background worker memory usage. | Grafana Alert |
| **14:08** | Detection | Automated alert paged On-Call Lead. | PagerDuty |
| **14:15** | Containment | Scaled worker pool & cleared queue. | Manual Action |
| **14:44** | Resolution | Deployed patch `v1.2.1` with memory caps. | CI/CD Deploy |

---

## 3. Root Cause Analysis (The 5 Whys)
1. **Why did the API crash?** $\rightarrow$ Worker node ran out of memory (OOM).
2. **Why did it run out of memory?** $\rightarrow$ A background job loaded a 4GB dataset into RAM at once.
3. **Why did it load the full dataset?** $\rightarrow$ Pagination parameter was omitted in the query payload.
4. **Why was pagination missing?** $\rightarrow$ The endpoint lacked input schema validation for array bounds.
5. **Why was validation missing?** $\rightarrow$ Systemic gap: API review checklists do not require execution limits on bulk export endpoints.

---

## 4. Contributing Factors
- **Monitoring Gap:** No alert was configured for database connection pool saturation prior to node OOM.
- **Process Gap:** Staging environment data volume was too small to surface memory scaling limits during integration testing.

---

## 5. Preventative Action Items

| Action Item | Category | Assignee | Due Date | Target Ticket |
| :--- | :--- | :--- | :--- | :--- |
| Add memory boundary limit to API validator | Prevention | `@developer` | 2026-10-05 | `ENG-402` |
| Configure connection pool saturation alert at 80% | Detection | `@devops` | 2026-10-02 | `OPS-118` |
| Seed staging DB with realistic volume mock data | Process | `@qa-lead` | 2026-10-12 | `QA-88` |
