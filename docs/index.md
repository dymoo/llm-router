# Operator documentation

Compose runs the gateway, plus Open WebUI behind the `webui` profile. The local model runtime is Gufo on the owner's GPU host, reached over HTTP with a bearer key; it is not a Compose service. Only gateway and WebUI publish ports, both loopback by default.

| Document                               | Use                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| [setup.md](setup.md)                   | Secrets, binds, Gufo endpoint and gateway setup                                             |
| [routing-policy.md](routing-policy.md) | Key policy, Gufo-first tiers, cloud switch and Flex (authoritative)                         |
| [batch.md](batch.md)                   | Low-priority batch surface: submit/status/list/delete, deferred lane, spill, result holding |
| [catalogue.md](catalogue.md)           | Gufo, OpenRouter and System One entries without invented model IDs or prices                |
| [clients.md](clients.md)               | OMP / coding-agent requests, sessions and effort                                            |
| [operations.md](operations.md)         | Backup, drain, gateway upgrade, health, metrics, analytics                                  |
| [ai-hub.md](ai-hub.md)                 | Open WebUI through the gateway, and System One (Kev/Jev)                                    |

Files under `research/` are historical research, including the retired task classifier. Gufo host operations live in the owner's infra repository.

Model quality, Gufo throughput and paid cloud completions are **unverified** here. Identified SQLite v1→v6 migrations, software contracts and local protocol paths are exercised by tests.
