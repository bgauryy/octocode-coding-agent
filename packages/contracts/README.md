# Octocode shared contracts

The `contracts` package owns common contracts for packages and interfaces. Its package name is `@octocodeai/octocode-contracts`. Hosts load configuration and enforce permissions; see [configuration ownership](../../CONFIGURATIONS.md) and the [application boundary](../../docs/INTERFACE_ARCHITECTURE.md).

- `backlogs`: references, links, completion records and entity input schemas.
- `snapshot`: backlog states, notes, comments, audit records and presentation snapshots.
- `team`: agent presence and message delivery records.
- `workspace`: event, command, receipt and snapshot types.
- `protocol`: HTTP routes, runtime command/mutation schemas, report index and file payloads, and WebSocket event union.
- `application`: shared application commands, frames, snapshots, receipts and connection interfaces.
- `content` (root export): ordered display blocks, source annotations, session-scoped asset references and attachment schemas. Binary bytes and provider continuation tokens do not travel inside display blocks.
- `schema`: the shared string-enum schema helper, also re-exported by the AI package.
- `guards`: `isRecord` (plain object, arrays rejected) and `errorMessage`, the single copy every package imports.

Only TypeBox is a runtime dependency. Keep application behavior, database access, browser DOM, provider code, and permission decisions out of this package. Validate untrusted requests at the host boundary with these schemas; types alone do not validate JSON.

Run `yarn workspace @octocodeai/octocode-contracts run build` and `yarn workspace @octocodeai/octocode-contracts run test` from the repository root. Add a contract here when it crosses a real package or interface boundary; private persistence models stay with their owner.
