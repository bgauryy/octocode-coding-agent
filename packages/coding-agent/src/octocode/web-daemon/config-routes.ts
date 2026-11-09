import type http from "node:http";
import { Value } from "typebox/value";
import {
	ConfigCredentialCommandSchema,
	ConfigProviderCommandSchema,
	ConfigSettingCommandSchema,
	SignInCommandSchema,
	SignInStateSchema,
	type ConfigCredentialCommand,
	type ConfigProviderCommand,
	type ConfigSettingCommand,
	type SignInCommand,
	type SignInState,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { ConfigWriteError } from "./config-write.ts";
import { readJsonBody, type Reply, type TokenAccess } from "./http-util.ts";
import type { RepoCatalog } from "./repos.ts";

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
