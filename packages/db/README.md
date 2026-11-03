# @octocodeai/octocode-db

The private database workspace owns the SQLite schema, connection lifecycle, named entity queries and history retention. The coding-agent host bundles it and supplies the configured database and archive paths through its [connection adapter](../coding-agent/src/config/database.ts).

Feature code imports [the database API](src/api.ts). Each query family takes a database handle and returns a typed result. Group dependent writes inside `AgentDb.transaction`. Use the entity’s workspace identity when reading or writing workspace-scoped data. [Entity ownership](../../docs/ENTITIES.md) and [runtime storage](../coding-agent/docs/configuration.md#runtime-storage) describe scoping, files and retention.
