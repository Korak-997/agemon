---
name: skill-obsidian-vault-sync
description: Formats raw meeting notes, technical plans, and generated tasks into structured, bidirectional Obsidian markdown notes with WikiLinks, YAML frontmatter, Dataview tags, and consistent folder organizational rules.
triggers: ["@obsidian-sync", "format for obsidian", "create vault note", "obsidian note generator", "vault sync"]
---

# Instruction Rules
1. **Strict YAML Frontmatter:** Every generated note MUST begin with valid YAML frontmatter containing metadata fields (`title`, `date`, `tags`, `type`, `status`).
2. **Enforce Bidirectional Linking:** Automatically scan note content and wrap key domain concepts, people, systems, and projects in double brackets (e.g., `[[Projects/AITISI]]`, `[[People/Korak]]`, `[[Tech/Supabase]]`).
3. **Dataview Task Formatting:** Format inline action items using standard Dataview syntax (`- [ ] task description #task @assignee due:YYYY-MM-DD`).
4. **Output Format:** Pure, production-ready Obsidian Markdown code block ready for direct vault placement or API ingestion.

# Formatting Framework
- **Step 1: Note Categorization:** Identify note archetype (`meeting`, `architecture`, `task`, `project`, `journal`).
- **Step 2: Metadata & Frontmatter Generation:** Construct ISO timestamps, tags, and relational properties.
- **Step 3: Content Structuring & WikiLink Injection:** Format body text using standard headings (`##`) and apply `[[WikiLinks]]` to entities.
- **Step 4: Target Vault Location Declaration:** Specify exact destination path inside the vault folder structure.

---

# Output Schema

**Target Vault Path:** `Meetings/2026/2026-09-25-Architecture-Sync.md`

```markdown
---
title: "Architecture Sync - Redis Caching & DB Migration"
date: 2026-09-25
type: meeting
tags:
  - meeting/technical
  - project/infrastructure
  - status/action-required
status: open
related:
  - "[[Projects/AITISI]]"
  - "[[People/Korak]]"
---

# Architecture Sync - Redis Caching & DB Migration

## 📌 Context & Links
- **Project Hub:** [[Projects/AITISI]]
- **Lead Architect:** [[People/Korak]]
- **Primary Tech Stack:** [[Tech/Nuxt]], [[Tech/Supabase]], [[Tech/Redis]], [[Tech/PostgreSQL]]

---

## 📝 Key Notes & Architectural Decisions
Discussed API latency bottlenecks observed during peak load. To prevent database connection pool exhaustion in [[Tech/PostgreSQL]], we agreed to implement a caching layer using [[Tech/Redis]].

### Summary Points
- Database query times currently average ~180ms under high concurrency.
- Adding a [[Tech/Redis]] caching layer is expected to reduce read latency below 20ms for static routes.
- [[People/Korak]] will lead the implementation in `server/api/` and update system diagrams.

---

## ✅ Action Items & Tasks

- [ ] Implement Redis connection pool in API server #task @Korak due:2026-10-02 priority:high
- [ ] Benchmark query throughput on staging environment #task @Korak due:2026-10-05 priority:medium
- [ ] Update infrastructure configuration in [[DevOps/Coolify-Setup]] #task @unassigned due:2026-10-08 priority:low

---

## 🔗 Related Notes
- [[Architecture/ADR-004-Redis-Caching]]
- [[MeetingNotes/2026-09-18-Sprint-Planning]]
