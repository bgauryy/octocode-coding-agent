import type http from "node:http";
import { Value } from "typebox/value";
import {
	ConfigCredentialCommandSchema,
	ConfigProviderCommandSchema,
	ConfigSettingCommandSchema,
	HarnessSwitchCommandSchema,
	SignInCommandSchema,
	SignInStateSchema,
	ToolPinCommandSchema,
	type ConfigCredentialCommand,
	type ConfigProviderCommand,
	type ConfigSettingCommand,
	type HarnessSwitchCommand,
	type SignInCommand,
	type SignInState,
	type ToolPinCommand,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { ConfigWriteError } from "./config-write.ts";
import { readJsonBody, type Reply, type TokenAccess } from "./http-util.ts";
import type { RepoCatalog } from "./repos.ts";
import type { LiveTools } from "./session-tools.ts";

type Repo = { root?: string } | undefined;

export interface ConfigRoutes {
	catalog: Pick<RepoCatalog, "resolve">;
	/** Builds the configuration answer; the caller validates its shape. */
	config: (repo: Repo) => Promise<unknown>;
	/** Applies one validated setting change; throws `ConfigWriteError` for a refusal. */
	writeSetting?: (command: ConfigSettingCommand, repo: Repo) => Promise<void>;
	/** Sets or clears one provider key; throws `ConfigWriteError` for a refusal. The command carries the key: do not log it. */
	writeCredential?: (command: ConfigCredentialCommand) => Promise<void>;
	/** Turns one provider or the Pi source on or off; throws `ConfigWriteError` for a refusal. */
	writeProvider?: (command: ConfigProviderCommand) => Promise<void>;
	/** Runs one validated sign-in command (start, status, answer, cancel); throws `ConfigWriteError` for a refusal. */
	signIn?: (command: SignInCommand) => Promise<SignInState>;
	/** Lists the Harness panel's switches for the workspace; the caller validates its shape. */
	harness?: (repo: Repo) => Promise<unknown>;
	/** Switches one Harness row and returns the fresh list; throws `ConfigWriteError` for a refusal. */
	writeHarness?: (command: HarnessSwitchCommand, repo: Repo) => Promise<unknown>;
	/**
	 * Lists the Tools panel's rows (each tool's exposure state and pin) for the workspace; the caller validates its shape.
	 * `live` is what the running session declares, when the page belongs to one.
	 */
	tools?: (repo: Repo, live?: LiveTools) => Promise<unknown>;
	/** Pins or unpins one tool and returns the fresh list; throws `ConfigWriteError` for a refusal. */
	writeTools?: (command: ToolPinCommand, repo: Repo, live?: LiveTools) => Promise<unknown>;
	/**
	 * Records a credential request refused before `writeCredential` ran (`invalid` body, `forbidden` capability). Receives
	 * a fixed code only: never the body, a provider id from it or a token. It must not throw. Requests without a valid
	 * token are not recorded: anyone who can reach the port could grow the log.
	 */
	auditRefused?: (code: "invalid" | "forbidden") => void;
}

/** The page may change settings only with the launch capability; a published link reads them. */
const canWrite = (access: TokenAccess) => access === "launch";

async function snapshot(routes: ConfigRoutes, repo: Repo, access: TokenAccess, reply: Reply): Promise<void> {
	try {
		const value = await routes.config(repo);
		reply(200, value && typeof value === "object" ? { ...value, writable: canWrite(access) } : value);
	} catch (error) {
		reply(500, { error: redactSecrets(errorMessage(error)).slice(0, 500) });
	}
}

/**
 * The key is read from the body and handed to `writeCredential`; every reply here is fixed text or the snapshot, never
 * the body or an error message that could quote it.
 */
async function handleCredentialWrite(
	req: http.IncomingMessage,
	url: URL,
	access: TokenAccess,
	routes: ConfigRoutes,
	reply: Reply,
): Promise<void> {
	if (!routes.writeCredential) return reply(501, { error: "This daemon cannot change credentials." });
	const body = await readJsonBody(req, reply);
	if (body === undefined) {
		// Wrong content type, unreadable JSON or too large: already answered; still a refused launch-page attempt.
		routes.auditRefused?.("invalid");
		return;
	}
	if (!Value.Check(ConfigCredentialCommandSchema, body)) {
		routes.auditRefused?.("invalid");
		return reply(400, { error: "Invalid credential change" });
	}
	const command: ConfigCredentialCommand = body;
	try {
		await routes.writeCredential(command);
	} catch (error) {
		if (error instanceof ConfigWriteError) return reply(error.status, { error: error.message });
		return reply(500, { error: "The credential could not be saved." });
	}
	const repoParam = url.searchParams.get("repoId");
	const repo = repoParam ? routes.catalog.resolve(repoParam) : undefined;
	await snapshot(routes, repo, access, reply);
}

/** The command names a provider id or the Pi source and a switch: no secret. The reply is the fresh snapshot. */
async function handleProviderWrite(
	req: http.IncomingMessage,
	url: URL,
	access: TokenAccess,
	routes: ConfigRoutes,
	reply: Reply,
): Promise<void> {
	if (!routes.writeProvider) return reply(501, { error: "This daemon cannot change providers." });
	const body = await readJsonBody(req, reply);
	if (body === undefined) return;
	if (!Value.Check(ConfigProviderCommandSchema, body)) return reply(400, { error: "Invalid provider change" });
	try {
		await routes.writeProvider(body);
	} catch (error) {
		if (error instanceof ConfigWriteError) return reply(error.status, { error: error.message });
		return reply(500, { error: "The provider setting could not be saved." });
	}
	const repoParam = url.searchParams.get("repoId");
	await snapshot(routes, repoParam ? routes.catalog.resolve(repoParam) : undefined, access, reply);
}

/** The answer is a `SignInState`: events and a question for the user, never the body or a credential. */
async function handleSignIn(req: http.IncomingMessage, routes: ConfigRoutes, reply: Reply): Promise<void> {
	if (!routes.signIn) return reply(501, { error: "This daemon cannot sign in to providers." });
	const body = await readJsonBody(req, reply);
	if (body === undefined) {
		routes.auditRefused?.("invalid");
		return;
	}
	if (!Value.Check(SignInCommandSchema, body)) {
		routes.auditRefused?.("invalid");
		return reply(400, { error: "Invalid sign-in request" });
	}
	try {
		const state = await routes.signIn(body);
		if (!Value.Check(SignInStateSchema, state)) return reply(500, { error: "The sign-in state is invalid." });
		reply(200, state);
	} catch (error) {
		if (error instanceof ConfigWriteError) return reply(error.status, { error: error.message });
		reply(500, { error: "The sign-in could not be run." });
	}
}

/** One launch-only panel: `GET` lists its rows for a workspace, `POST` applies one validated change and answers with the fresh list. */
interface AdminPanel<Command extends { repoId?: string }> {
	list?: (repo: Repo) => Promise<unknown>;
	write?: (command: Command, repo: Repo) => Promise<unknown>;
	isCommand: (body: unknown) => body is Command;
	/** Fixed words for the replies: what cannot be listed or changed, an invalid body, a failed save. */
	words: { list: string; write: string; invalid: string; failed: string };
}

const HARNESS_PANEL = (routes: ConfigRoutes): AdminPanel<HarnessSwitchCommand> => ({
	list: routes.harness,
	write: routes.writeHarness,
	isCommand: (body): body is HarnessSwitchCommand => Value.Check(HarnessSwitchCommandSchema, body),
	words: {
		list: "This daemon cannot list harness switches.",
		write: "This daemon cannot change harness switches.",
		invalid: "Invalid switch change",
		failed: "The switch could not be saved.",
	},
});

const TOOLS_PANEL = (routes: ConfigRoutes): AdminPanel<ToolPinCommand> => ({
	list: routes.tools,
	write: routes.writeTools,
	isCommand: (body): body is ToolPinCommand => Value.Check(ToolPinCommandSchema, body),
	words: {
		list: "This daemon cannot list tool states.",
		write: "This daemon cannot pin tools.",
		invalid: "Invalid tool pin",
		failed: "The pin could not be saved.",
	},
});

/**
 * `GET` and `POST` of `/api/admin/config/harness` and `/api/admin/config/tools`: rows carry ids with file paths or the
 * names of configured servers, so both methods are launch-capability only.
 */
async function handlePanel<Command extends { repoId?: string }>(
	req: http.IncomingMessage,
	url: URL,
	access: TokenAccess,
	catalog: ConfigRoutes["catalog"],
	panel: AdminPanel<Command>,
	reply: Reply,
): Promise<void> {
	// The admin prefix already refused other tokens; this keeps it true if the prefix gate moves.
	if (!canWrite(access))
		return reply(403, { error: "This link cannot change settings. Use the page opened from the Octocode terminal." });
	if (req.method === "GET") {
		if (!panel.list) return reply(501, { error: panel.words.list });
		const repoParam = url.searchParams.get("repoId");
		const repo = repoParam ? catalog.resolve(repoParam) : undefined;
		if (repoParam && !repo) return reply(404, { error: "Unknown repository" });
		try {
			return reply(200, await panel.list(repo));
		} catch (error) {
			return reply(500, { error: redactSecrets(errorMessage(error)).slice(0, 500) });
		}
	}
	if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
	if (!panel.write) return reply(501, { error: panel.words.write });
	const body = await readJsonBody(req, reply);
	if (body === undefined) return;
	if (!panel.isCommand(body)) return reply(400, { error: panel.words.invalid });
	const repo = body.repoId ? catalog.resolve(body.repoId) : undefined;
	if (body.repoId && !repo) return reply(404, { error: "Unknown repository" });
	try {
		reply(200, await panel.write(body, repo));
	} catch (error) {
		if (error instanceof ConfigWriteError) return reply(error.status, { error: error.message });
		reply(500, { error: panel.words.failed });
	}
}

/**
 * `GET /api/config` (every capability) and `POST /api/admin/config/settings` (launch capability only: the admin prefix
 * is refused to other tokens before this runs, and the check here keeps it true if the prefix gate moves). The write
 * reply is the fresh snapshot, so the page shows what the files now say. Returns false for any other route.
 */
export async function handleConfigRequest(
	req: http.IncomingMessage,
	url: URL,
	access: TokenAccess,
	routes: ConfigRoutes,
	reply: Reply,
): Promise<boolean> {
	if (req.method === "GET" && url.pathname === DAEMON_ROUTES.config) {
		const repoParam = url.searchParams.get("repoId");
		const repo = repoParam ? routes.catalog.resolve(repoParam) : undefined;
		if (repoParam && !repo) reply(404, { error: "Unknown repository" });
		else await snapshot(routes, repo, access, reply);
		return true;
	}
	if (url.pathname === DAEMON_ROUTES.configHarness) {
		await handlePanel(req, url, access, routes.catalog, HARNESS_PANEL(routes), reply);
		return true;
	}
	if (url.pathname === DAEMON_ROUTES.configTools) {
		await handlePanel(req, url, access, routes.catalog, TOOLS_PANEL(routes), reply);
		return true;
	}
	const isCredentialRoute =
		url.pathname === DAEMON_ROUTES.configCredentials || url.pathname === DAEMON_ROUTES.configSignin;
	const isProviderRoute = url.pathname === DAEMON_ROUTES.configProviders;
	if (url.pathname !== DAEMON_ROUTES.configSettings && !isCredentialRoute && !isProviderRoute) return false;
	if (req.method !== "POST") {
		reply(405, { error: "Method not allowed" });
		return true;
	}
	if (!canWrite(access)) {
		if (isCredentialRoute) routes.auditRefused?.("forbidden");
		reply(403, { error: "This link cannot change settings. Use the page opened from the Octocode terminal." });
		return true;
	}
	if (isProviderRoute) {
		await handleProviderWrite(req, url, access, routes, reply);
		return true;
	}
	if (url.pathname === DAEMON_ROUTES.configSignin) {
		await handleSignIn(req, routes, reply);
		return true;
	}
	if (url.pathname === DAEMON_ROUTES.configCredentials) {
		await handleCredentialWrite(req, url, access, routes, reply);
		return true;
	}
	if (!routes.writeSetting) {
		reply(501, { error: "This daemon cannot change settings." });
		return true;
	}
	const body = await readJsonBody(req, reply);
	if (body === undefined) return true;
	if (!Value.Check(ConfigSettingCommandSchema, body)) {
		reply(400, { error: "Invalid setting change" });
		return true;
	}
	const command: ConfigSettingCommand = body;
	const repo = command.repoId ? routes.catalog.resolve(command.repoId) : undefined;
	if (command.repoId && !repo) {
		reply(404, { error: "Unknown repository" });
		return true;
	}
	try {
		await routes.writeSetting(command, repo);
	} catch (error) {
		if (error instanceof ConfigWriteError) reply(error.status, { error: error.message });
		else reply(500, { error: "The setting could not be saved." });
		return true;
	}
	await snapshot(routes, repo, access, reply);
	return true;
}
