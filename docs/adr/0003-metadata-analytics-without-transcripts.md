# Analytics is metadata now; transcripts are a later per-key opt-in

Operators need first-class trends for policy reasons, COGS, cache, timing, saturation, and errors. Storing chats to get those views would create a prompt archive by default, spend on a success evaluator, and confuse HTTP 200 with task success. The Router therefore records **request metadata** for analytics now and does **not** collect transcripts. Full capture and a task-success classifier are an explicit future opt-in, not current behaviour.

**Status:** accepted

**Considered options:** (1) counters only on the key table; (2) log full chats from day one; (3) metadata analytics now, transcripts later under per-key opt-in (chosen). (1) cannot answer locality, cache, or exclusion questions. (2) is hard to reverse once prompts are on disk and needs access, retention, redaction, and a storage budget that do not exist yet.

**Consequences:** HTTP success is not task success. Observed test/tool outcomes, if ever recorded, stay distinct from model judgments. A later evaluator, if any, is async, sampled, and deduplicated, with spend separate from inference. No paid evaluator on the default path. This ADR does not claim the analytics UI exists.
