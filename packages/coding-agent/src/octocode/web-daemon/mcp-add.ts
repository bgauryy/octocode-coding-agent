import type http from "node:http";
import { Value } from "typebox/value";
import {
	McpAddCommandSchema,
	type McpAddCommand,
	type McpAddResult,
	type McpAddAvailability,
} from "@octocodeai/octocode-contracts/config";
import {
	McpAddError,
	saveMcpDefinition,
	presetEntries,
	recommendedPresets,
	browserPreset,
	currentMcpServerNames,
} from "../../../../mcp/src/api.ts";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { readJsonBody, type TokenAccess, type Reply } from "./http-util.ts";
import type { RepoCatalog } from "./repos.ts";
import { ConfigWriteError } from "./config-write.ts";

const REGISTRY_UNAVAILABLE =
	"Open a running session's page and choose Settings to add MCP servers. Its complete MCP registry must be available to check names; reconnect or reload an older session first. No definition was saved.";

export function mcpAddAvailability(readNames: () => string[] | undefined = currentMcpServerNames): McpAddAvailability {
	try {
		return readNames() === undefined ? { available: false, message: REGISTRY_UNAVAILABLE } : { available: true };
	} catch {
		return { available: false, message: REGISTRY_UNAVAILABLE };
	}
}

export function addWebMcp(
	command: McpAddCommand,
	options: {
		agentDir: string;
		cwd?: string;
		actor: string;
		audit?: (entry: ConfigAuditEntry) => void;
		mcpServerNames?: () => string[] | undefined;
	},
): McpAddResult {
	if (!Value.Check(McpAddCommandSchema, command)) throw new ConfigWriteError(400, "Invalid MCP definition.");
	const trusted = options.cwd !== undefined && resolveFolderTrust(options.cwd).state === "trusted";
	if (command.scope === "workspace" && !options.cwd)
		throw new ConfigWriteError(400, "Choose a workspace before saving.");
	if (command.scope === "workspace" && !trusted)
		throw new ConfigWriteError(403, "Trust this workspace with /trust before saving an MCP definition.");
	let registeredNames: string[] | undefined;
	try {
		registeredNames = (options.mcpServerNames ?? currentMcpServerNames)();
	} catch {
		throw new ConfigWriteError(503, REGISTRY_UNAVAILABLE);
	}
	if (registeredNames === undefined) throw new ConfigWriteError(503, REGISTRY_UNAVAILABLE);
	let result: McpAddResult | undefined;
	let failure: ConfigWriteError | undefined;
	try {
		result = saveMcpDefinition(command, {
			agentDir: options.agentDir,
			cwd: options.cwd ?? options.agentDir,
			projectTrusted: trusted,
			existingNames: [
				...registeredNames,
				...presetEntries([...recommendedPresets(), browserPreset()]).map((entry) => entry.name),
			],
		});
	} catch (cause) {
		failure = new ConfigWriteError(
			409,
			cause instanceof McpAddError ? cause.message : "Could not save the MCP definition.",
		);
	}
	let warning: string | undefined;
	try {
		options.audit?.({
			at: Date.now(),
			actor: options.actor,
			action: "mcp.add",
			target: "mcp",
			scope: command.scope,
			afterKind: "off",
			outcome: result ? "ok" : "failed",
		});
	} catch {
		warning = "The MCP save attempt could not be recorded in the audit log.";
	}
	if (failure) throw new ConfigWriteError(failure.status, `${failure.message}${warning ? ` ${warning}` : ""}`);
	return { ...result!, ...(warning ? { warnings: [warning] } : {}) };
}

/** The request is write-only. Even failures never include submitted values or parser diagnostics. */
export async function handleMcpAddRequest(
	req: http.IncomingMessage,
	url: URL,
	access: TokenAccess,
	routes: {
		catalog: Pick<RepoCatalog, "resolve">;
		mcpAddStatus?: (repo: ReturnType<RepoCatalog["resolve"]>) => Promise<McpAddAvailability>;
		addMcp?: (command: McpAddCommand, repo: ReturnType<RepoCatalog["resolve"]>) => Promise<McpAddResult>;
	},
	reply: Reply,
): Promise<void> {
	if (req.method !== "POST" && req.method !== "GET") {
		reply(405, { error: "Method not allowed" });
		return;
	}
	if (access !== "launch") {
		reply(403, { error: "This link cannot add MCP servers. Use the page opened from the Octocode terminal." });
		return;
	}
	if (req.method === "GET") {
		const repoId = url.searchParams.get("repoId");
		const repo = repoId ? routes.catalog.resolve(repoId) : undefined;
		if (repoId && !repo) {
			reply(404, { error: "Unknown repository" });
			return;
		}
		try {
			reply(
				200,
				routes.mcpAddStatus ? await routes.mcpAddStatus(repo) : { available: false, message: REGISTRY_UNAVAILABLE },
			);
		} catch {
			reply(200, { available: false, message: REGISTRY_UNAVAILABLE });
		}
		return;
	}
	const body = await readJsonBody(req, reply);
	if (body === undefined) return;
	if (!Value.Check(McpAddCommandSchema, body)) {
		reply(400, { error: "Invalid MCP definition." });
		return;
	}
	const repo = body.repoId ? routes.catalog.resolve(body.repoId) : undefined;
	if (body.repoId && !repo) {
		reply(404, { error: "Unknown repository" });
		return;
	}
	if (!routes.addMcp) {
		reply(503, { error: "Adding MCP servers is unavailable." });
		return;
	}
	try {
		reply(200, await routes.addMcp(body, repo));
	} catch (cause) {
		reply(cause instanceof ConfigWriteError ? cause.status : 500, {
			error: cause instanceof ConfigWriteError ? cause.message : "Could not save the MCP definition.",
		});
	}
}
