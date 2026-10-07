# Embeddings stream to one local deployment

`POST /v1/embeddings` serves OpenAI embeddings from one local deployment (EmbeddingGemma-2 on the Strix Halo NPU). Its inputs can carry base64 images, audio and video, so a body can be 64 MiB, while the router runs in a 256 MB Fly machine with a 150 MB V8 heap. Parsing such a body would hold it two or three times over (bytes, string, objects), so the router does not parse it:

- The body streams from Caddy through the router to the server unchanged, with the client's `Content-Length` (required; the server needs it). A small scanner reads the top-level `model` as the bytes pass and holds back the last chunk until it has seen it: a wrong or missing model aborts the upload before the server has the whole body.
- Because the body is not rewritten, the deployment's `id` must equal its `modelId`, and there is exactly one embeddings deployment: there is nothing to choose, so routing does not need the body. The server validates everything else (`input`, `dimensions`, media, limits) and its 400/413 messages reach the client.
- Embeddings never fall back. Vectors from another model live in another space, so a cloud or chat substitute would silently corrupt an index. An unreachable server is **503 `unavailable`**.
- Accounting is per key like chat: one request, the server's `usage.prompt_tokens` (media count as their expanded tokens), the item count in the decision trace, and cost from the catalogue rate (0 for local).

**Status:** accepted (2026-10-07)

**Considered options:** (1) buffer and parse like System One: rejected, 64 MiB bodies do not fit the machine; (2) cap router bodies well below the server's limits: rejected, video and audio need them; (3) route by a model found in the first bytes: rejected, OpenAI's Python SDK sends `input` before `model`.

**Consequences:** a second embeddings model needs routing that does not depend on the body's end (for example a header or a path), and this ADR revisited. Chunked uploads without `Content-Length` are 411.
