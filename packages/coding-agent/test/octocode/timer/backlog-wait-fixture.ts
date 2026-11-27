import type { AgentDb } from "../../../../db/src/api.ts";
import type { BacklogStore } from "../../../src/octocode/backlog/store.ts";
import { fixtureBacklog } from "../backlog-fixture.ts";

/** A board over `agent` for workspace `id`. */
export const backlogFixtureFor = (agent: AgentDb, id: string): BacklogStore => fixtureBacklog(() => agent, id);
