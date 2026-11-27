# @octocodeai/octocode-contracts

Serializable contracts shared across packages and interfaces: TypeBox schemas and types. The only runtime dependency is TypeBox. Hosts load configuration and enforce permissions ([application boundary](../../docs/INTERFACE_ARCHITECTURE.md)).

| Module (subpath)   | Holds                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root               | Re-exports `backlogs`, `snapshot`, `team`, `workspace`, `protocol`, `profiler`, `application`, `content`, `stream`, tool progress and display, `question` and replies |
| `backlogs`         | References, links, completion records, entity input schemas                                                                                                           |
| `snapshot`         | Backlog states, notes, comments, audit records, presentation snapshots                                                                                                |
| `team`             | Agent presence and message delivery records                                                                                                                           |
| `workspace`        | Event, command, receipt and snapshot types                                                                                                                            |
| `protocol`         | HTTP routes, command/mutation schemas, report index and file payloads, WebSocket event union                                                                          |
| `application`      | Shared commands, frames, snapshots, receipts, connection interfaces                                                                                                   |
| `content`          | Ordered display blocks, source annotations, session-scoped asset references, attachments; no binary bytes or provider continuation tokens inside blocks               |
| `profiler`         | Cache-profiler wire shapes                                                                                                                                            |
| `config`           | Configuration read model for the web Settings page (credential source kinds, never keys)                                                                              |
| `daemon`           | Daemon HTTP surface, session attach protocol                                                                                                                          |
| `docs`             | Docs library routes                                                                                                                                                   |
| `external`         | External-agent protocol types                                                                                                                                         |
| `schema`, `guards` | `StringEnum` helper (re-exported by the AI package); `isRecord`, `errorMessage`                                                                                       |

Keep application behavior, database access, DOM, provider code and permission decisions out. Validate untrusted requests at the host boundary with these schemas; types alone do not validate JSON. Add a contract only when it crosses a real package or interface boundary; private persistence models stay with their owner.

```sh
yarn workspace @octocodeai/octocode-contracts run build
yarn workspace @octocodeai/octocode-contracts run test
```
