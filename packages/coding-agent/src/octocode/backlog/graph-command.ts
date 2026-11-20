import type { AgentDb } from "../../../../db/src/api.ts";
import type { BacklogStore } from "./store.ts";
import { workGraph } from "../graph/model.ts";
import { graphJson, graphText } from "../graph/render.ts";
import { readRunLockSnap } from "../graph/run-lock.ts";
import type { JobSource } from "../graph/model.ts";
import { readGraphSources } from "./graph-sources.ts";

export interface GraphCommandInput {
	agentDb: AgentDb;
	store: BacklogStore;
	repo: string;
	root: string;
	now: number;
	json: boolean;
	/** Print one item's tree. */
	item?: string;
	/** Job origins besides the database: a command line has none, a session passes its running-work rows. */
	jobs?: readonly JobSource[];
	runLockDir?: string;
}

/**
 * What `octocode backlog graph` prints: the tree of running work, or its nodes and edges as JSON. It reads the database
 * and the full-run lock record and makes no model call.
 */
export function graphCommandText(input: GraphCommandInput): string {
	const graph = workGraph(
		readGraphSources({
			agentDb: input.agentDb,
			store: input.store,
			repo: input.repo,
			root: input.root,
			now: input.now,
			runLock: readRunLockSnap(input.runLockDir),
			...(input.jobs ? { jobs: input.jobs } : {}),
		}),
	);
	return input.json ? JSON.stringify(graphJson(graph, input.item), null, 2) : graphText(graph, input.item);
}
