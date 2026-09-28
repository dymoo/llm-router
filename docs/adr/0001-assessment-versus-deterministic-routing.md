# Optional semantic assessment, always deterministic policy

The Router **always** applies deterministic policy for hard constraints, locality and ranking weights, admission, and a reservation held through execution. In explicit `laya` or `jev` mode, it first asks the qualified backend for an Assessment. In explicit `rules` mode, it does not construct a classifier or invent an Assessment: deployment facts and Key policy feed the same selection seam. This updates the original mandatory-assessment decision so unqualified classifiers need not block operation; it is not automatic fallback on classifier failure.

Official TypeSafe guidance keeps arithmetic, authorization, lookups, and side effects in code, and says raw judgments should stay reusable when a weight or filter changes if evidence and question meanings are unchanged. Live wait, load, and price text therefore stay out of classifier state. A semantic quality rubric belongs in questions only when it changes meaning.

A **bounded Choice** over already-filtered deployment IDs is a supported System One use (“chooses which LLM receives each prompt”). It is a **deferred alternative**, not forbidden by the skill. Even then, admission and budgets remain code: a Choice cannot reserve capacity. Sourced evidence: [jev-routing.md](../research/jev-routing.md).

**Status:** superseded (2026-09-28). The task classifier, Rules mode and ranking were removed; keys route by `priority` and a `cloud` switch, Gufo first ([routing-policy.md](../routing-policy.md)). Kept as history. Earlier: mandatory assessment superseded by explicit Rules mode (2026-09-26).

**Considered options:** (1) Assessment plus deterministic Route, always (original choice; retained in Laya/Jev modes); (2) no Assessment (now chosen explicitly in Rules mode while qualification is pending); (3) Jev as the sole router, with deterministic fallback on timeout; (4) bounded candidate Choice after hard filters (valid, deferred). (3) would embed slider arithmetic and live occupancy in the rubric and bust judgment reuse. (4) remains legal to evaluate later; it does not replace reservation in code.

**Consequences:** Slider changes do not require a new Assessment when the brief and question schema are unchanged. Rules mode has no difficulty or task-quality signal and uses the lowest supported deployment effort; its full contract is in [routing-policy.md](../routing-policy.md). Classifier outage in Laya/Jev mode remains fail-closed, never a guessed Route or automatic paid fallback. Confidence is not task success.
