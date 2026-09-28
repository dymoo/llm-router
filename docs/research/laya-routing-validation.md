# Laya routing validation: software works, semantic quality is not established

Date: 2026-09-20. Actual CPU execution on the development Mac, using `laya==0.3.4`, the pinned root `convaiinnovations/laya` revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, float32 CPU inference, max length 512/head budget 192. These are diagnostic examples, not a routing benchmark or model-quality certification.

## Observed

The local model loads, reports healthy, applies tokenizer-aware limits, returns typed answers and measured input usage, and supports exact assessment reuse. Over-budget state returns an explicit rejection. The gateway does not silently switch to Jev.

A production-container protocol smoke used the synthetic task:

> Write a TypeScript function that adds two numbers.

With the gateway's task-and-deployment metadata state, Laya selected `chat`, with low confidence on the other choices, and judged local sufficiency below the 0.8 admission threshold. The gateway rejected the local-only catalogue with `no_eligible_model`, recording the assessment and exclusion. A greeting also failed that local-sufficiency gate.

A controlled input-format diagnostic used the same seven questions:

| State form                                  | Task choice                                           | Observation                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task text alone                             | coding; probability 0.9563; entropy confidence 0.8861 | Task classification improved, but `trivialChat` was 0.8451 and local sufficiency 0.3137. No local catalogue was supplied in this diagnostic arm. |
| Structured task plus local deployment       | chat                                                  | Metadata materially changed the answer.                                                                                                          |
| Plain labelled task and deployment sections | extraction                                            | Formatting alone did not establish a reliable fix.                                                                                               |

The upstream API is being called with its documented `predict(state, questions)` contract, and the service preserves rather than invents the outputs. These examples do **not** establish that Laya is generally unusable, but they do establish that this question/state combination is not yet validated for trustworthy production routing.

## Decision

Do not reduce quality/locality thresholds, replace model answers with heuristics, select a different checkpoint silently, or introduce automatic paid fallback to make the smoke test turn green. Keep the explicit backend selection and fail-closed behavior.

For production-quality routing, either explicitly select Jev with authorized credentials or calibrate Laya's question/state design against a representative labelled task set before trusting it. The software's Jev integration is tested through the real SDK against an isolated HTTP fixture; no paid Jev classification has been run here. Switching the default classifier remains an operator decision, not an agent-selected spending commitment.

A real-model local-classifier quality gate is separate from HTTP/SQLite/streaming protocol acceptance. Protocol fixtures verify routes and accounting but do not count as evidence of classifier or generator quality.

## Additional correctness fix

The upstream Laya sequence builder can trim not only task state but also long option descriptions and the question head. The service now rejects those head/criterion losses before inference as well. The 512-token context and 192-token head budget are separate constraints; a shorter caller brief cannot repair an oversized question rubric.

## Sources

- [Laya package source](https://github.com/NandhaKishorM/laya)
- [Pinned model snapshot](https://huggingface.co/convaiinnovations/laya/tree/1c5edc17a7acd8701df6fc341c0d179f1c62c982)
- Installed `laya/agent.py` and `laya/common.py` from version 0.3.4 were inspected during the experiment.
