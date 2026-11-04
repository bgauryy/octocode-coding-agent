# @octocodeai/octocode-db

The private database workspace owns the SQLite schema, connection lifecycle, named entity queries and history retention. The coding-agent host bundles it and supplies the configured database and archive paths through its [connection adapter](../coding-agent/src/config/database.ts).

Feature code imports [the database API](src/api.ts). Each query family takes a database handle and returns a typed result. Group dependent writes inside `AgentDb.transaction`. Use the entity’s workspace identity when reading or writing workspace-scoped data. [Entity ownership](../../docs/ENTITIES.md) and [runtime storage](../coding-agent/docs/configuration.md#runtime-storage) describe scoping, files and retention.

## Changing the schema

Edit [the schema](src/schema-sql.ts), which is what a new file starts from, then raise `SCHEMA_PLAN.version` and add one step to [the migrations](src/migrations.ts), so existing files reach the same shape. Mark a step `additive` only when an older Octocode can keep using the file: new tables, indexes, and nullable or defaulted columns.

[The runner](src/migrate.ts) backs the file up with `VACUUM INTO`, because other live sessions write this WAL database, and runs each step under `BEGIN IMMEDIATE`, rechecking `user_version` once it holds the lock. A failed step rolls back alone and the file stays at the last version that completed. `AgentDbError` reaches the user at startup: the folder trust gate fails closed, so Octocode exits naming the file and the version needed.
