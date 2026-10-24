---
name: skill-prd-decomposer
description: Decomposes PRDs, feature requests, or technical specs into engineering-ready Epics and User Stories with testable Given/When/Then acceptance criteria.
triggers: ["@prd-decomposer", "decompose prd", "create epics", "generate user stories", "breakdown backlog"]
---

# Instruction Rules
1. **Enforce Atomic Stories:** Every generated user story must be small enough to implement in a single focused engineering session (1–3 days max).
2. **Strict Acceptance Criteria:** Never use vague criteria like "works properly". Use explicit, testable statements or Given/When/Then formats.
3. **Include Verification & Edge Cases:** Every story must specify UI, API, or DB verification steps alongside boundary conditions.
4. **Output Format:** Clean Markdown using standard user story notation and tabular tracking matrices.

# Decomposition Framework
- **Step 1: Core Domain Identification:** Group raw requirements into logical functional Epics.
- **Step 2: Story Mapping:** Break Epics into vertical user-facing or technical backend slices.
- **Step 3: Criteria & Contract Definition:** Write clear acceptance criteria and technical dependencies for each story.
- **Step 4: Backlog Matrix:** Tabulate story points, risk factors, and implementation order.

---

# Output Schema

## 1. Feature Breakdown & Epic Mapping
- **Input PRD / Concept:** [Name or link to source PRD]
- **Target Release:** [e.g., Sprint 14 / v1.2.0]

---

## 2. Epic & Story Details

### EPIC-01: [Epic Title]
**Goal:** [Short statement on what business capability this Epic enables]

#### US-101: [Story Title]
- **As a** [user/role]
- **I want to** [action/capability]
- **So that** [business benefit/value]

**Technical Notes & Scope:**
- Target Files/Modules: `server/api/users.ts`, `components/UserProfile.vue`
- Out of Scope: [What explicitly NOT to build in this story]

**Acceptance Criteria:**
- [ ] **AC-1 (Given/When/Then):** Given an authenticated user, when they click "Save", then validate inputs and save to database.
- [ ] **AC-2 (Validation):** Return a `400 Bad Request` with an error payload if the email string is invalid.
- [ ] **AC-3 (Verification):** Database record updated and cache invalidated.

---

#### US-102: [Story Title]
- **As a** [user/role]
- **I want to** [action/capability]
- **So that** [business benefit/value]

**Acceptance Criteria:**
- [ ] **AC-1:** [Verifiable criterion]
- [ ] **AC-2:** [Verifiable criterion]

---

## 3. Backlog Execution Matrix

| Story ID | Summary | Effort (Points) | Dependencies | Risk Level |
| :--- | :--- | :--- | :--- | :--- |
| **US-101** | [Short summary] | 2 | None | Low |
| **US-102** | [Short summary] | 3 | US-101 | Medium |

## 4. Definition of Done Checklist
- [ ] All acceptance criteria pass across listed user stories.
- [ ] Code passes type-checks, linting, and existing test suites.
- [ ] PR includes updated documentation or API specs if contracts changed.
