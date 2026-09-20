# Domain docs

## Before exploring

Read root `CONTEXT.md` for domain vocabulary and relevant decisions in `docs/adr/`. This repository uses a single context. If a document does not exist, proceed silently; domain-modeling creates glossary entries and decisions when they are needed.

## Layout

- `CONTEXT.md`: domain glossary only, not an implementation specification.
- `docs/adr/`: numbered architectural decisions.
- `docs/routing-policy.md`: routing behavior and configurable policy decisions.

Use glossary terms consistently in code discussions, issues, tests, and proposals. Note genuine missing concepts for domain-modeling. If a proposal conflicts with an ADR, name the decision and explain why it should be reconsidered instead of silently overriding it.
