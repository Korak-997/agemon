---
name: skill-tech-spike
description: Scopes out unknown technical territories, verifies third-party integrations, evaluates library trade-offs, and designs proof-of-concept execution paths before sprint commitment.
triggers: ["@spike", "tech spike", "proof of concept", "feasibility check", "investigate library"]
---

# Instruction Rules
1. **Focus on risk mitigation and speed over production code.** A spike must answer a single technical question or prove/disprove a hypothesis.
2. **Explicitly state timeboxes and scope boundaries.** Do not expand the scope beyond the target hypothesis.
3. **Identify all third-party limits:** Rate limits, licensing restrictions, authentication overhead, and hardware/memory footprints.
4. **Output format:** Use clean Markdown with structured tables and runnable evaluation code snippets.

# Spike Execution Framework
- **Phase 1: Hypothesis & Objectives:** What specific technical uncertainty are we solving?
- **Phase 2: Feasibility & Boundary Evaluation:** Benchmark dependencies, APIs, and potential execution bottlenecks.
- **Phase 3: Minimal Proof of Concept (PoC):** Provide an isolated code snippet or test suite to prove viability.
- **Phase 4: Recommendation & Sprint Hand-off:** Go/No-Go verdict with effort estimates.

---

# Output Schema

## 1. Spike Definition & Scope
- **Hypothesis:** [e.g., "Supabase Realtime can handle 1,000 concurrent updates/sec without database lockups"]
- **Timebox Limit:** [e.g., 4 Hours]
- **Core Question:** [The single question that determines success/failure]

## 2. Technical Evaluation Matrix

| Criterion | Target Requirement | Evaluated Metric | Pass / Fail |
| :--- | :--- | :--- | :--- |
| **Performance / Latency** | < 200ms roundtrip | ~85ms | PASS |
| **API Rate Limits** | > 5,000 req/min | 10,000 req/min | PASS |
| **License / Security** | MIT / Apache 2.0 | AGPLv3 (Risk) | WARNING |
| **Bundle / Overhead** | < 50KB gzip | 120KB gzip | FAIL |

## 3. Minimal Viable Proof-of-Concept (PoC)

Provide isolated, executable code to validate the integration:

```typescript
// Minimal execution test
import { createClient } from '@supabase/supabase-js';

async function testSpike() {
  console.time('Spike-Latency');
  // 1. Establish connection
  // 2. Execute target function
  // 3. Verify error boundaries
  console.timeEnd('Spike-Latency');
}
```
