import {
	isActiveCredential,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
} from "@octocodeai/octocode-ai";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { normalizePath } from "../../../../common/src/paths.ts";
import { isCommandConfigValue, resolveConfigValue } from "../config-value.ts";
import type { AuthStorageData } from "./backends.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { readJsonFile } from "../../../../common/src/json.ts";

/** Why a credential entry is not one Octocode reads, or undefined when it is. */
function invalidEntryReason(credential: unknown): string | undefined {
	if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return "not an object";
	const value = credential as Record<string, unknown>;
	if (value.type === "api_key") {
		const validKey = value.key === undefined || typeof value.key === "string";
		const validEnv =
			value.env === undefined ||
			(typeof value.env === "object" &&
				value.env !== null &&
				!Array.isArray(value.env) &&
				Object.values(value.env).every((entry) => typeof entry === "string"));
		return validKey && validEnv ? undefined : "an api_key entry needs a string key and string env values";
	}
	if (value.type === "oauth") {
		const valid =
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires);
		return valid ? undefined : "an oauth entry needs string access and refresh tokens and a numeric expires";
	}
	return typeof value.type === "string" ? `type "${value.type}" is not api_key or oauth` : "it has no type";
}

interface ReadOnlyAuthStorageOptions {
	/**
	 * Skip what cannot be read instead of failing: an unreadable or malformed file holds nothing, an unrecognized entry
	 * is left out. Each problem is reported once, naming the file. Used for fallback files Octocode does not own.
	 */
	onProblem?: (message: string) => void;
}

export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private readonly onProblem: ((message: string) => void) | undefined;
	private data: AuthStorageData | undefined;

	constructor(authPath: string = join(getAgentDir(), "auth.json"), options: ReadOnlyAuthStorageOptions = {}) {
		this.authPath = normalizePath(authPath);
		this.onProblem = options.onProblem;
	}

	/** What a lenient read of `authPath` skips, each naming the file; empty when every entry is usable. */
	static problems(authPath: string): string[] {
		const problems: string[] = [];
		new ReadOnlyAuthStorage(authPath, { onProblem: (message) => problems.push(message) }).load();
		return problems;
	}

	private load(): AuthStorageData {
		if (this.data) return this.data;
		const path = this.authPath;
		const onProblem = this.onProblem;

		let parsed: unknown;
		try {
			parsed = readJsonFile(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.data = {};
				return this.data;
			}
			if (onProblem) {
				// The parser's message can quote the file's text, which may hold a key: name the file only.
				onProblem(`Skipped ${path}: it could not be read as JSON, so none of its credentials are used.`);
				this.data = {};
				return this.data;
			}
			throw new Error(`Failed to read ${path}: ${errorMessage(error)}`, { cause: error });
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			if (!onProblem) throw new Error(`Invalid auth.json: expected an object (${path})`);
			onProblem(`Skipped ${path}: it is not a JSON object, so none of its credentials are used.`);
			this.data = {};
			return this.data;
		}
		// No prototype: an entry named `__proto__` stays an entry.
		const data = Object.create(null) as AuthStorageData;
		for (const [providerId, credential] of Object.entries(parsed)) {
			const reason = invalidEntryReason(credential);
			if (!reason) {
				data[providerId] = credential as AuthStorageData[string];
				continue;
			}
			if (!onProblem)
				throw new Error(`Invalid auth.json credential for provider "${providerId}" in ${path}: ${reason}`);
			onProblem(`Skipped the "${providerId}" entry in ${path}: ${reason}. Its other entries are still used.`);
		}

		this.data = onProblem ? data : (parsed as AuthStorageData);
		return this.data;
	}

	/** Read a validated credential without evaluating key references or commands. */
	async readRaw(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const data = this.load();
		// An own key only: a provider id such as `constructor` must not read an inherited property.
		const credential = Object.hasOwn(data, providerId) ? data[providerId] : undefined;
		options?.signal?.throwIfAborted();
		return credential ? structuredClone(credential) : undefined;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = await this.readRaw(providerId, options);
		if (!credential) return undefined;
		if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
			return credential;
		}
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load())
			.filter(([, credential]) => isActiveCredential(credential))
			.map(([providerId, credential]) => ({
				providerId,
				type: credential.type,
			}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}
