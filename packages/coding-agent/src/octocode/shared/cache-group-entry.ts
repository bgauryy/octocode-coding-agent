/**
 * The session entry (`api.session.appendEntry`, never sent to the model) that says which cache group a child's requests belong
 * to. A child writes it (`subagents/cache-group.ts`) and the profiler reads it (`profiler/cache-group.ts`): the same
 * `prefix` with a different `key` points at provider routing, a different `prefix` at a prompt or tool difference.
 */
export const CACHE_GROUP_ENTRY = "octocode-cache-group";
