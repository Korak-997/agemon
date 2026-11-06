---
name: skill-task-extractor
description: Scans transcripts, meeting notes, or raw discussion threads to extract commitments, convert vague statements into precise tasks, assign owners, infer explicit ISO deadlines, and generate structured task payloads.
triggers: ["@extract-tasks", "extract todos", "generate action items", "transcript to tasks", "task extractor"]
---

# Instruction Rules
1. **Normalize Vague Statements:** Transform vague discussion points (e.g., *"We should fix the database errors next week"*) into clear, actionable task titles (e.g., *"Implement connection pool timeout handling for PostgreSQL"*).
2. **Explicit Date Conversion:** Convert all relative date references (e.g., *"by end of week"*, *"next Tuesday"*) into strict ISO format (`YYYY-MM-DD`), anchored to the transcript's own date/timestamp if it has one. If no reference date is available, ask the user for one before converting rather than guessing.
3. **Owner Attribution:** Match mentioned names or roles to explicit task owners. If unassigned, mark clearly as `UNASSIGNED`.
4. **Output Format:** Dual-format output containing a human-readable Obsidian Task list and a machine-readable JSON payload ready for PM tool APIs (Jira/Linear/Todoist/GitHub Issues).

# Extraction Framework
- **Step 1: Text Scanning & Intent Detection:** Scan inputs for action verbs, commitments, promises, and assignments.
- **Step 2: Task Clarification:** Expand context to make every task self-contained without needing to re-read the original transcript.
- **Step 3: Priority & Effort Inference:** Assign priority (`High`, `Medium`, `Low`) based on discussion urgency and risk.
- **Step 4: Payload Formatting:** Generate both Markdown tasks and JSON API structures.

---

# Output Schema

# Extracted Action Items

## 1. Task Summary Matrix

| Task ID | Action Title | Assignee | Priority | Due Date | Target Module |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TASK-01** | Configure Redis connection pooling for API routes | [[Korak]] | High | 2026-10-02 | `server/api/` |
| **TASK-02** | Update Figma mockups for mobile onboarding flow | [[Sarah]] | Medium | 2026-09-30 | UI / UX |
| **TASK-03** | Verify staging environment SSL certificate auto-renewal | UNASSIGNED | Low | 2026-10-05 | DevOps |

---

## 2. Obsidian Task List (Markdown Format)

- [ ] **TASK-01:** Configure Redis connection pooling for API routes #task @Korak due:2026-10-02 priority:high
- [ ] **TASK-02:** Update Figma mockups for mobile onboarding flow #task @Sarah due:2026-09-30 priority:medium
- [ ] **TASK-03:** Verify staging environment SSL certificate auto-renewal #task @unassigned due:2026-10-05 priority:low

---

## 3. Machine-Readable API Payload (JSON)

```json
{
  "source": "Meeting Transcript",
  "generated_at": "2026-09-25",
  "tasks": [
    {
      "id": "TASK-01",
      "title": "Configure Redis connection pooling for API routes",
      "description": "Implement connection pool parameters and handle timeout errors to prevent API latency spikes.",
      "assignee": "Korak",
      "priority": "High",
      "due_date": "2026-10-02",
      "tags": ["backend", "performance", "redis"]
    },
    {
      "id": "TASK-02",
      "title": "Update Figma mockups for mobile onboarding flow",
      "description": "Simplify signup screens down to 2 steps as agreed during the roadmap sync.",
      "assignee": "Sarah",
      "priority": "Medium",
      "due_date": "2026-09-30",
      "tags": ["design", "ux", "mobile"]
    },
    {
      "id": "TASK-03",
      "title": "Verify staging environment SSL certificate auto-renewal",
      "description": "Confirm the staging cert renews automatically before it next expires.",
      "assignee": "UNASSIGNED",
      "priority": "Low",
      "due_date": "2026-10-05",
      "tags": ["devops", "infra"]
    }
  ]
}
```
