# Operator documentation

Compose runs the gateway, plus Open WebUI behind the `webui` profile. The local model runtime is Gufo on the owner's GPU host, reached over HTTP with a bearer key; it is not a Compose service. Only gateway and WebUI publish ports, both loopback by default.

| Document                                           | Use                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                               | Secrets, binds, Gufo endpoint and gateway setup                                             |
| [routing-policy.md](routing-policy.md)             | Locality bias, priority and Flex, hard limits (authoritative)                               |
| [batch.md](batch.md)                               | Low-priority batch surface: submit/status/list/delete, deferred lane, spill, result holding |
| [catalogue.md](catalogue.md)                       | Gufo, OpenRouter and System One entries without invented model IDs or prices                |
| [clients.md](clients.md)                           | OMP / coding-agent session metadata                                                         |
| [operations.md](operations.md)                     | Backup, drain, gateway upgrade, health, metrics, analytics                                  |
| [ai-hub.md](ai-hub.md)                             | Open WebUI through the gateway, and System One (Kev/Jev)                                    |
| [research/jev-routing.md](research/jev-routing.md) | Jev assessment design and sourced limits                                                    |

Other files under `research/` are historical research from before Gufo. Gufo host operations live in the owner's infra repository.

Model quality, Gufo throughput and paid cloud completions are **unverified** here. Identified SQLite v1→v5 migrations, software contracts and local protocol paths are exercised by tests.
