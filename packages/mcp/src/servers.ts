import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type {
	McpExposure,
	McpHttpServerConfig,
	McpServerChange,
	McpServerConfig,
	RegisteredMcpServer,
} from "@octocodeai/octocode-contracts/mcp-server";
import { createToolNameMatcher, isPluginMcpServerName, mcpNamespace } from "../../common/src/mcp-names.ts";
import { isStringRecord, LOOPBACK_HOSTS, validateInstall, validateOAuth, validateRoles } from "./server-validation.ts";

/**
 * MCP server configuration and the servers extensions register with `api.registerMcpServer()`.
 *
 * The core only validates and stores registrations. The MCP extension (built in, or another
 * extension that handles `mcp_servers_change`) connects them next to the servers from `mcp.json`.
 */

/**
 * - `direct`: tools are declared to the model, and the server's block describes them in full.
 * - `deferred`: tools are declared the same way, but the block lists only each tool's name and trigger; the agent
 *   loads the full description and schema with the `mcp` tool (`deferral.ts`).
 * - `hidden`: tools are registered but unreachable.
 */
export const DEFAULT_MCP_EXPOSURE = "direct";

export const MCP_EXPOSURES = ["direct", "deferred", "hidden"] as const satisfies readonly McpExposure[];

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/**
 * A namespace (`-` read as `_`) with `__` inside or `_` at its end makes `mcp__<server>__<tool>` ambiguous: server `a`
 * with tool `b__c` and server `a__b` with tool `c` would share a name, and `mcp__a__*` would also select `a__b`.
 */
const AMBIGUOUS_NAMESPACE = /__|_$/;
export function isMcpExposure(value: unknown): value is McpExposure {
	return MCP_EXPOSURES.some((mode) => mode === value);
}

/** Exposure the configuration sets for one tool: explicit tool settings, then the server's; undefined without either. */
export function configuredMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure | undefined {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && createToolNameMatcher([pattern])(toolName)) return exposure;
	}
	return config.exposure;
}

/** Exposure of one tool: explicit tool settings, then the server's exposure, then `direct`. */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	return configuredMcpToolExposure(config, toolName) ?? DEFAULT_MCP_EXPOSURE;
}

const exposureError = (): string => `must be one of ${MCP_EXPOSURES.map((exposure) => `"${exposure}"`).join(", ")}`;

/** Validate one server entry of the `mcpServers` shape. Returns the config, or an error message. */
export function validateMcpServerConfig(name: string, value: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name) && !isPluginMcpServerName(name))
		return `invalid server name "${name}" (use letters, digits, "_" and "-", or plugin:<plugin>:<server>)`;
	if (AMBIGUOUS_NAMESPACE.test(mcpNamespace(name).slice("mcp__".length)))
		return `invalid server name "${name}" (no "__" and no "_" or "-" at the end: tool names are mcp__<server>__<tool>)`;
	if (!isRecord(value)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, defaultActive, timeout, toolExposure, description } = value;
	if (exposure !== undefined && !isMcpExposure(exposure)) return `server "${name}": exposure ${exposureError()}`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure)) {
			if (!isMcpExposure(entry)) return `server "${name}": toolExposure "${tool}" ${exposureError()}`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (defaultActive !== undefined && typeof defaultActive !== "boolean")
		return `server "${name}": defaultActive must be a boolean`;
	if (description !== undefined && typeof description !== "string") {
		return `server "${name}": description must be a string`;
	}
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	const rolesError = validateRoles(value.roles);
	if (rolesError) return `server "${name}": ${rolesError}`;
	if (value.install !== undefined && typeof value.command !== "string") {
		return `server "${name}": install needs a stdio server ("command")`;
	}
	if (type === "sse") return `server "${name}": legacy SSE is unsupported; use a Streamable HTTP endpoint`;
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
			return `server "${name}": url must be an http or https URL`;
		}
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			return `server "${name}": headers must map names to strings`;
		}
		if (value.literalHeaders !== undefined && typeof value.literalHeaders !== "boolean") {
			return `server "${name}": literalHeaders must be a boolean`;
		}
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
				return `server "${name}": auth.provider must be a provider name`;
			}
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
		if (value.inheritEnv !== undefined && typeof value.inheritEnv !== "boolean")
			return `server "${name}": inheritEnv must be a boolean`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		const installError = validateInstall(value.install);
		if (installError) return `server "${name}": ${installError}`;
		return value as unknown as Exclude<McpServerConfig, McpHttpServerConfig>;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (Streamable HTTP)`;
}

/** Servers registered by the extensions of one runtime. */
export class McpServerRegistry {
	private servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;

	private updated(changes: readonly McpServerChange[]): Map<string, RegisteredMcpServer> {
		const servers = new Map(this.servers);
		for (const change of changes) {
			if (change.type === "unregister") {
				if (servers.get(change.name)?.extensionPath === change.extensionPath) servers.delete(change.name);
				continue;
			}
			const { server } = change;
			const existing = servers.get(server.name);
			if (existing !== undefined && existing.extensionPath !== server.extensionPath) {
				// An inherited server yields to another owner's registration of the same name, and never displaces one.
				if (server.inherited && !existing.inherited) continue;
				if (!existing.inherited)
					throw new Error(`MCP server "${server.name}" is already registered by extension "${existing.extensionPath}"`);
			}
			const clash = [...servers.values()].find(
				(existing) => existing.name !== server.name && mcpNamespace(existing.name) === mcpNamespace(server.name),
			);
			if (clash) throw new Error(`MCP server "${server.name}" conflicts with registered server "${clash.name}"`);
			servers.set(server.name, server);
		}
		return servers;
	}

	validate(changes: readonly McpServerChange[]): void {
		this.updated(changes);
	}

	/** Revalidate against the current registry before publishing the whole batch. */
	apply(changes: readonly McpServerChange[]): void {
		if (changes.length === 0) return;
		const servers = this.updated(changes);
		const changed = changes.some((change) => change.type === "register") || servers.size !== this.servers.size;
		this.servers = servers;
		if (changed) this.changeListener?.();
	}

	/** Register or replace the same owner's server. */
	register(server: RegisteredMcpServer): void {
		this.apply([{ type: "register", server }]);
	}

	/** Remove a server registered by `extensionPath`. Servers of other extensions are left alone. */
	unregister(name: string, extensionPath: string): void {
		this.apply([{ type: "unregister", name, extensionPath }]);
	}

	get(name: string): RegisteredMcpServer | undefined {
		return this.servers.get(name);
	}

	/** Copies of the registered servers, in registration order. */
	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}

	/** Called after every change. The runner sets it when it binds, to emit `mcp_servers_change`. */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
