import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, shortHash } from "@octocodeai/octocode-common/atomic-file";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { getAgentDir } from "../../config.ts";
import { globalPaths, privateDir } from "../shared/home.ts";

/** What a process learned about a refused credential: enough to route around it at the next start. */
interface StoredRefusal {
	at: number;
	via: "run" | "check";
	/** The provider's error text, already redacted by the caller. */
	detail: string;
}

/** Credential refusals that outlive the process; `ProviderHealth` reads them once and writes each change. */
export interface RefusalStore {
	/** The saved refusals whose credential is still the one that was refused. */
	load(): Map<string, StoredRefusal>;
	/** Saves a refusal (`undefined`: forgets it). A provider whose credential cannot be identified is never saved. */
	save(provider: string, refusal: StoredRefusal | undefined): void;
}

/**
 * A short digest naming the credential `auth.json` holds for a provider, so a refusal applies only to that credential:
 * an OAuth sign-in is its refresh token (an access token is renewed all the time), an API key its key, anything else
 * its whole entry. Undefined when the provider has no saved credential (an environment or runtime key cannot be
 * told apart from its replacement). Reads one local file; nothing leaves it but the digest.
 */
export function authFingerprint(authFile: string): (provider: string) => string | undefined {
	return (provider) => {
		let entry: unknown;
		try {
			entry = asRecord(JSON.parse(fs.readFileSync(authFile, "utf8")))[provider];
		} catch {
			return undefined;
		}
		if (!isRecord(entry)) return undefined;
		const secret =
			typeof entry.refresh === "string" ? entry.refresh : typeof entry.key === "string" ? entry.key : undefined;
		return shortHash(`${String(entry.type)}\n${secret ?? JSON.stringify(entry)}`);
	};
}

interface FileEntry extends StoredRefusal {
	/** `authFingerprint` of the refused credential. */
	credential: string;
}

const isFileEntry = (value: unknown): value is FileEntry =>
	isRecord(value) &&
	typeof value.at === "number" &&
	(value.via === "run" || value.via === "check") &&
	typeof value.detail === "string" &&
	typeof value.credential === "string";

/** Refusals kept in one JSON file (provider id to entry); a missing or damaged file holds none. */
export function fileRefusalStore(file: string, fingerprint: (provider: string) => string | undefined): RefusalStore {
	const read = (): Map<string, FileEntry> => {
		try {
			const parsed = asRecord(JSON.parse(fs.readFileSync(file, "utf8")));
			return new Map(Object.entries(parsed).filter((pair): pair is [string, FileEntry] => isFileEntry(pair[1])));
		} catch {
			return new Map();
		}
	};
	return {
		load: () =>
			new Map(
				[...read()]
					.filter(([provider, entry]) => fingerprint(provider) === entry.credential)
					.map(([provider, { at, via, detail }]) => [provider, { at, via, detail }]),
			),
		save(provider, refusal) {
			const entries = read();
			const credential = fingerprint(provider);
			if (refusal && credential === undefined) return;
			if (refusal && credential !== undefined) entries.set(provider, { ...refusal, credential });
			else if (!entries.delete(provider)) return;
			privateDir(path.dirname(file));
			atomicWriteFileSync(file, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
		},
	};
}

/** The store `providerHealth` uses: beside the models.dev index, against the agent directory's `auth.json`. */
export function defaultRefusalStore(): RefusalStore {
	const open = () =>
		fileRefusalStore(
			path.join(globalPaths().agentState, "provider-refusals.json"),
			authFingerprint(path.join(getAgentDir(), "auth.json")),
		);
	return { load: () => open().load(), save: (provider, refusal) => open().save(provider, refusal) };
}
