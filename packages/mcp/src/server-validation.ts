import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** Validators of single fields of a server entry, for `validateMcpServerConfig` (`servers.ts`). Each returns an error or undefined. */

export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const MCP_TOOL_ROLES = ["reader", "search", "judge", "readOnly"] as const;

/** Whether a redirect URI can be served by Octocode's loopback callback server. */
function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

export function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		return "oauth.clientSecret must be a string";
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
		return "oauth.clientName must be a non-empty string";
	}
	if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
		if (value.clientRegistration !== "cimd") return 'oauth.clientRegistration must be "dcr" or "cimd"';
		if (value.clientId !== undefined || value.clientName !== undefined) {
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		const callback = typeof value.callbackUrl === "string" ? new URL(value.callbackUrl) : undefined;
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
			return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
		}
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return undefined;
}

const isNameList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "" && !item.includes("*"));

export function validateRoles(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "roles must be an object";
	for (const [role, names] of Object.entries(value)) {
		if (!MCP_TOOL_ROLES.some((known) => known === role)) {
			return `roles.${role} is not a role (use ${MCP_TOOL_ROLES.join(", ")})`;
		}
		if (!isNameList(names)) return `roles.${role} must be an array of tool names without "*"`;
	}
	return undefined;
}

const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

export function validateInstall(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "install must be an object";
	const extra = Object.keys(value).filter((key) => !["npm", "version", "bin", "hostDependency"].includes(key));
	if (extra.length) return `install has unknown keys: ${extra.join(", ")}`;
	if (typeof value.npm !== "string" || !NPM_NAME.test(value.npm)) return "install.npm must be an npm package name";
	if (typeof value.version !== "string" || !/^[\w.+-]+$/.test(value.version)) {
		return "install.version must be an exact version";
	}
	if (value.bin !== undefined && (typeof value.bin !== "string" || !value.bin.trim())) {
		return "install.bin must be a non-empty string";
	}
	if (value.hostDependency !== undefined && typeof value.hostDependency !== "boolean") {
		return "install.hostDependency must be a boolean";
	}
	return undefined;
}
