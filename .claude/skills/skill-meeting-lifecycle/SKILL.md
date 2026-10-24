---
name: skill-meeting-lifecycle
description: Processes raw transcripts or meeting notes into structured intelligence, distinguishing executive summaries, key decisions, speaker attributions, and follow-up items.
triggers: ["@meeting-notes", "process transcript", "meeting summary", "meeting notes", "call breakdown"]
---

# Instruction Rules
1. **Never Hallucinate Commitments:** Only extract decisions and action items explicitly stated or clearly implied in the transcript.
2. **Dual-Tier Summary:** Always provide both a high-level executive brief (for leadership/stakeholders) and a granular technical breakdown (for engineering).
3. **Obsidian Integration:** Auto-generate `[[WikiLinks]]` for people, projects, and key technologies mentioned.
4. **Output Format:** Clean Markdown using structured tables and actionable checklists.

# Processing Framework
- **Step 1: Context & Metadata Extraction:** Identify meeting date, purpose, attendees, and project context.
- **Step 2: Executive & Granular Synthesis:** Summarize core outcomes and group discussion points by technical topic.
- **Step 3: Decision Log:** Extract concrete architectural, product, or operational decisions made during the call.
- **Step 4: Action Items Extraction:** Prepare raw task payloads for downstream PM tools or Obsidian daily notes.

---

# Output Schema

# Meeting Notes: [Meeting Title / Topic]

## 1. Meeting Overview
- **Date & Time:** {{YYYY-MM-DD}}
- **Attendees:** [[Person A]], [[Person B]], [[Person C]]
- **Project Context:** [[Project Name]]
- **Executive Brief:** [2-3 concise sentences summarizing the core outcome of the call]

---

## 2. Key Decisions Made
| # | Decision | Rationale | Owner / Lead |
| :--- | :--- | :--- | :--- |
| **1** | Migrating auth layer to Supabase | Reduces custom maintenance overhead | [[Person A]] |
| **2** | Postpone feature X to Sprint 15 | Prioritizing API performance fixes | [[Person B]] |

---

## 3. Topic Breakdown & Discussion Notes

### Topic A: [e.g., Infrastructure & Database Scaling]
- Discussion focused on recent API latency spikes under load.
- [[Person A]] shared telemetry showing connection pool exhaustion.
- Consensus reached to add Redis caching before doubling database instance size.

### Topic B: [e.g., Q3 Product Roadmap Adjustments]
- Reviewed client feedback on onboarding workflow.
- Agreed to simplify signup steps down to 2 screens.

---

## 4. Raw Action Items
- [ ] **Task 1:** [[Person A]] to draft Redis caching proposal by Friday.
- [ ] **Task 2:** [[Person B]] to update Figma designs for simplified onboarding.
- [ ] **Task 3:** [[Person C]] to check staging environment log retention settings.

---

## 5. Unresolved Questions & Next Steps
- [ ] **Open Item:** How will the new caching layer handle multi-region invalidation?
- **Next Sync:** Scheduled for {{YYYY-MM-DD}}
