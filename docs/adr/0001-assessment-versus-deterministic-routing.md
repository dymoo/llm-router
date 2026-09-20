# Semantic assessment, then deterministic policy — always

The Router **always** asks Laya or Jev for a semantic Assessment and **always** applies deterministic policy for hard constraints, locality and ranking weights, admission, and a reservation held through execution. That split is the design, not a fallback after a failed “classifier owns the route” attempt.

Official TypeSafe guidance keeps arithmetic, authorization, lookups, and side effects in code, and says raw judgments should stay reusable when a weight or filter changes if evidence and question meanings are unchanged. Live wait, load, and price text therefore stay out of classifier state. A semantic quality rubric belongs in questions only when it changes meaning.

A **bounded Choice** over already-filtered deployment IDs is a supported System One use (“chooses which LLM receives each prompt”). It is a **deferred alternative**, not forbidden by the skill. Even then, admission and budgets remain code: a Choice cannot reserve capacity. Sourced evidence: [jev-routing.md](../research/jev-routing.md).

**Status:** accepted

**Considered options:** (1) Assessment plus deterministic Route, always (chosen); (2) no Assessment; (3) Jev as the sole router, with deterministic fallback on timeout; (4) bounded candidate Choice after hard filters (valid, deferred). (3) would embed slider arithmetic and live occupancy in the rubric and bust judgment reuse. (4) remains legal to evaluate later; it does not replace reservation in code.

**Consequences:** Slider changes do not require a new Assessment when the brief and question schema are unchanged. Classifier outage is not a guessed Route and not an automatic paid fallback. Confidence is not task success. This ADR does not claim a catalogue-ID Choice is unimplemented or banned.
