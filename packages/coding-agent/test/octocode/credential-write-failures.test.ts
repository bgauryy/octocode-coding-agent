import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { KeychainCommandError, type KeychainBackend } from "../../src/core/auth-storage/keychain.ts";
import { ReadOnlyAuthStorage } from "../../src/core/auth-storage/read-only.ts";
import type { ConfigAuditEntry } from "../../../db/src/queries/config-audits.ts";
import { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";
import { writeConfigCredential } from "../../src/octocode/web-daemon/credential-write.ts";

/**
 * Failure paths of the configuration page's credential write, driven through `writeConfigCredential` with a real
 * `auth.json` lock in a temp folder and a fake keychain (never the real home or keychain).
 */
const NEW = "SENTINEL-NEW-1a2b3c";
const OLD = "SENTINEL-OLD-4d5e6f";
let root: string;
let agentDir: string;
let keychainDir: string;

beforeEach(() => {
	// The provider's key check accepts every key here, so only the write paths under test decide; nothing leaves the machine.
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-credential-failures-"));
	agentDir = path.join(root, "agent");
	keychainDir = path.join(root, "keychain");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(keychainDir);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

interface Hooks {
	store?: (provider: string, secret: string, write: () => void) => Promise<void>;
	remove?: (provider: string, remove: () => void) => Promise<void>;
}
const file = (provider: string) => path.join(keychainDir, provider);
const reference = (provider: string) => `!cat ${file(provider)}`;
function fakeKeychain(hooks: Hooks = {}): KeychainBackend {
	return {
		name: "fake keychain",
		store: async (provider, secret) => {
			const write = () => fs.writeFileSync(file(provider), secret);
			if (hooks.store) await hooks.store(provider, secret, write);
			else write();
		},
		remove: async (provider) => {
			const remove = () => fs.rmSync(file(provider), { force: true });
			if (hooks.remove) await hooks.remove(provider, remove);
			else remove();
		},
		referenceFor: reference,
		isOwnReference: (key, provider) => key === reference(provider),
	};
}
const entryOf = (provider: string) =>
	fs.existsSync(file(provider)) ? fs.readFileSync(file(provider), "utf8") : undefined;
const authFile = () => path.join(agentDir, "auth.json");
const readAuth = (): Record<string, any> => JSON.parse(fs.readFileSync(authFile(), "utf8"));
const seed = (value: unknown) => fs.writeFileSync(authFile(), JSON.stringify(value));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(
	command: Parameters<typeof writeConfigCredential>[0],
	keychain: KeychainBackend | null,
	audits: ConfigAuditEntry[] = [],
) {
	return writeConfigCredential(command, {
		agentDir,
		keychain,
		env: {},
		actor: "web:test",
		audit: (entry) => audits.push(entry),
	});
}
const set = (provider = "openai", key = NEW, extra: object = {}) => ({
	action: "set" as const,
	provider,
	key,
	...extra,
});
const clear = (provider = "openai") => ({ action: "clear" as const, provider });
const failure = async (promise: Promise<unknown>): Promise<ConfigWriteError> => {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(ConfigWriteError);
	return error as ConfigWriteError;
};

/** Makes the next `n`-th auth.json replacement behave as `behavior` says; the others run for real. */
function onRename(behavior: (real: () => void, call: number) => void) {
	const real = fs.renameSync;
	let calls = 0;
	vi.spyOn(fs, "renameSync").mockImplementation((from, to) => behavior(() => real(from, to), ++calls));
}
const diskFull = () => Object.assign(new Error("no space left"), { code: "ENOSPC" });

describe("Clear", () => {
	it("does not report success while the keychain entry remains, keeps the reference, and can be retried", async () => {
		const audits: ConfigAuditEntry[] = [];
		let locked = true;
		const keychain = fakeKeychain({
			remove: async (_provider, remove) => {
				if (locked) throw new Error("keychain locked");
				remove();
			},
		});
		await run(set(), keychain);
		expect(entryOf("openai")).toBe(NEW);

		const refused = await failure(run(clear(), keychain, audits));
		expect([refused.status, refused.code]).toEqual([500, "keychain"]);
		expect(refused.message).toContain("kept");
		expect(entryOf("openai")).toBe(NEW);
		expect(readAuth().openai).toEqual({ type: "api_key", key: reference("openai") });
		expect(audits.map((row) => [row.outcome, row.errorCode])).toEqual([["failed", "keychain"]]);

		locked = false;
		await run(clear(), keychain, audits);
		expect(entryOf("openai")).toBeUndefined();
		expect(readAuth().openai).toBeUndefined();
	});

	it("says so when the keychain entry stays and the reference could not be put back", async () => {
		const keychain = fakeKeychain({
			remove: async () => {
				throw new Error("keychain locked");
			},
		});
		await run(set(), keychain);
		// Replacement 1 removes the auth.json entry; replacement 2 (the put-back) fails.
		onRename((real, call) => {
			if (call === 2) throw diskFull();
			real();
		});
		const error = await failure(run(clear(), keychain));
		expect(error.code).toBe("keychain-leftover");
		expect(error.message).toContain("keychain app");
		expect(entryOf("openai")).toBe(NEW);
		expect(readAuth().openai).toBeUndefined();
	});

	it("does not say nothing changed when the entry was already removed before the failure", async () => {
		const keychain = fakeKeychain();
		await run(set(), keychain);
		onRename((real) => {
			real();
			throw diskFull();
		});
		const error = await failure(run(clear(), keychain));
		expect(error.code).toBe("unconfirmed");
		expect(error.message).not.toContain("Nothing was changed");
	});
});

describe("a failed set", () => {
	it("says the key may have changed when the keychain rollback itself fails", async () => {
		const audits: ConfigAuditEntry[] = [];
		const keychain = fakeKeychain({
			remove: async () => {
				throw new Error("keychain locked");
			},
		});
		onRename(() => {
			throw diskFull();
		});
		const error = await failure(run(set(), keychain, audits));
		expect([error.status, error.code]).toEqual([500, "unknown"]);
		expect(error.message).not.toContain("Nothing was changed");
		expect(error.message).not.toContain(NEW);
		expect(entryOf("openai")).toBe(NEW);
		expect(audits[0]).toMatchObject({ outcome: "failed", errorCode: "unknown" });
	});

	it("keeps the keychain entry and says the key was saved when auth.json was replaced before the failure", async () => {
		const keychain = fakeKeychain();
		onRename((real) => {
			real();
			throw Object.assign(new Error("lock compromised"), { code: "ECOMPROMISED" });
		});
		const error = await failure(run(set(), keychain));
		expect(error.code).toBe("unconfirmed");
		expect(error.message).toContain("was saved");
		expect(entryOf("openai")).toBe(NEW);
		expect(readAuth().openai.key).toBe(reference("openai"));
	});

	it("keeps the keychain entry and reports unknown when auth.json cannot be read afterwards", async () => {
		const keychain = fakeKeychain();
		onRename(() => {
			fs.writeFileSync(authFile(), "{ not json");
			throw diskFull();
		});
		const error = await failure(run(set(), keychain));
		expect(error.code).toBe("unknown");
		expect(entryOf("openai")).toBe(NEW);
	});

	it("restores the earlier key when the replacement keeps the same reference and the write fails", async () => {
		const keychain = fakeKeychain();
		await run(set("openai", OLD), keychain);
		onRename(() => {
			throw diskFull();
		});
		const error = await failure(run(set(), keychain));
		expect([error.status, error.message]).toEqual([500, "The key could not be saved. Nothing was changed."]);
		expect(entryOf("openai")).toBe(OLD);
	});

	it("does not say nothing changed when the earlier key could not be read and so cannot be restored", async () => {
		seed({ openai: { type: "api_key", key: reference("openai") } }); // The entry behind it is missing.
		const keychain = fakeKeychain();
		onRename(() => {
			throw diskFull();
		});
		const error = await failure(run(set(), keychain));
		expect(error.code).toBe("unknown");
		expect(entryOf("openai")).toBe(NEW);
	});

	it("undoes a keychain write that timed out after storing (fresh key and replacement)", async () => {
		const timeoutAfterStoring: Hooks = {
			store: async (_provider, secret, write) => {
				if (secret === NEW) {
					write();
					throw new Error("timed out");
				}
				write();
			},
		};
		const keychain = fakeKeychain(timeoutAfterStoring);
		const fresh = await failure(run(set(), keychain));
		expect([fresh.status, fresh.code]).toEqual([502, "keychain"]);
		expect(entryOf("openai")).toBeUndefined();

		await run(set("openai", OLD), keychain);
		const replaced = await failure(run(set(), keychain));
		expect(replaced.code).toBe("keychain");
		expect(entryOf("openai")).toBe(OLD);
	});

	it("refuses without side effects when an OAuth sign-in appears after the first check", async () => {
		const keychain = fakeKeychain();
		const real = ReadOnlyAuthStorage.prototype.readRaw;
		vi.spyOn(ReadOnlyAuthStorage.prototype, "readRaw").mockImplementationOnce(async function (
			this: ReadOnlyAuthStorage,
			...args
		) {
			const seen = await real.apply(this, args);
			seed({ openai: { type: "oauth", access: "a", refresh: "r", expires: 1 } });
			return seen;
		});
		const error = await failure(run(set(), keychain));
		expect([error.status, error.code]).toEqual([409, "oauth"]);
		expect(entryOf("openai")).toBeUndefined();
		expect(readAuth().openai.type).toBe("oauth");
	});
});

describe("concurrent writes", () => {
	it("keeps the second request's key when the first fails and its rollback is slow", async () => {
		const keychain = fakeKeychain({
			remove: async (_provider, remove) => {
				await sleep(250); // The window in which a second writer used to slip in.
				remove();
			},
		});
		let second: Promise<void> | undefined;
		onRename((real, call) => {
			if (call === 1) {
				second = run(set("openai", OLD), keychain);
				throw diskFull();
			}
			real();
		});
		const first = await failure(run(set(), keychain));
		expect(first.message).toContain("Nothing was changed");
		await second;
		expect(entryOf("openai")).toBe(OLD);
		expect(readAuth().openai.key).toBe(reference("openai"));
	});
});

describe("a keychain that refuses", () => {
	const locked = async () => {
		throw new Error("keychain locked");
	};

	it("reports a definite refusal as a keychain error even when the undo would fail too", async () => {
		const audits: ConfigAuditEntry[] = [];
		const keychain = fakeKeychain({
			store: async () => {
				throw new KeychainCommandError("denied", 1);
			},
			remove: locked,
		});
		const error = await failure(run(set(), keychain, audits));
		expect([error.status, error.code]).toEqual([502, "keychain"]);
		expect(error.message).toContain("Nothing was changed");
		expect(audits[0]).toMatchObject({ outcome: "failed", errorCode: "keychain" });
		expect(fs.existsSync(authFile()) ? (readAuth().openai ?? null) : null).toBeNull();
	});

	it("does not undo a replacement the keychain refused, and keeps the earlier key", async () => {
		const keychain = fakeKeychain({
			store: async (_provider, secret, write) => {
				if (secret === NEW) throw new KeychainCommandError("denied", 1);
				write();
			},
		});
		await run(set("openai", OLD), keychain);
		const error = await failure(run(set(), keychain));
		expect(error.code).toBe("keychain");
		expect(entryOf("openai")).toBe(OLD);
	});

	it("still treats a killed command (no exit code) as possibly written and unknown when the undo fails", async () => {
		const keychain = fakeKeychain({
			store: async (_provider, _secret, write) => {
				write();
				throw new KeychainCommandError("timed out", null);
			},
			remove: locked,
		});
		const error = await failure(run(set(), keychain));
		expect(error.code).toBe("unknown");
		expect(entryOf("openai")).toBe(NEW);
	});
});

describe("Clear and Set for one provider", () => {
	it("run one after the other, so a slow keychain removal cannot delete the newer key", async () => {
		const keychain = fakeKeychain({
			remove: async (_provider, remove) => {
				await sleep(200);
				remove();
			},
		});
		await run(set(), keychain);
		const cleared = run(clear(), keychain);
		const replaced = run(set("openai", OLD), keychain);
		await Promise.all([cleared, replaced]);
		expect(entryOf("openai")).toBe(OLD);
		expect(readAuth().openai.key).toBe(reference("openai"));
	});

	it("does not make a failed request block the next one", async () => {
		const keychain = fakeKeychain();
		onRename((real, call) => {
			if (call === 1) throw diskFull();
			real();
		});
		const first = failure(run(set(), keychain));
		const second = run(set("openai", OLD), keychain);
		expect((await first).code).toBe("write");
		await second;
		expect(entryOf("openai")).toBe(OLD);
	});
});

describe("provider ids that name Object.prototype members", () => {
	it("reads no inherited property as a credential", async () => {
		fs.writeFileSync(authFile(), "{}");
		for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
			expect(await new ReadOnlyAuthStorage(authFile()).readRaw(id), id).toBeUndefined();
			expect(await AuthStorage.create(authFile()).read(id), id).toBeUndefined();
			expect(await AuthStorage.create(authFile()).modify(id, async (current) => current), id).toBeUndefined();
		}
		expect(readAuth()).toEqual({});
	});

	it("sets and clears a key under such an id like any other", async () => {
		const keychain = fakeKeychain();
		await run(set("constructor"), keychain);
		expect(Object.hasOwn(readAuth(), "constructor")).toBe(true);
		expect(entryOf("constructor")).toBe(NEW);
		await run(clear("constructor"), keychain);
		expect(Object.hasOwn(readAuth(), "constructor")).toBe(false);
		expect(entryOf("constructor")).toBeUndefined();
	});

	it("does not mistake an inherited property for a stored credential on Clear", async () => {
		fs.writeFileSync(authFile(), "{}");
		await run(clear("constructor"), fakeKeychain());
		expect(readAuth()).toEqual({});
	});
});

describe.skipIf(process.platform === "win32")("plain text", () => {
	it("makes an existing group-readable auth.json owner-only when the key is saved, and only then", async () => {
		seed({ other: { type: "api_key", key: "x" } });
		fs.chmodSync(authFile(), 0o644);
		const refused = await failure(run(set(), null));
		expect(refused.code).toBe("plaintext");
		expect(fs.statSync(authFile()).mode & 0o777).toBe(0o644);

		await run(set("openai", NEW, { acknowledgePlaintext: true }), null);
		expect(fs.statSync(authFile()).mode & 0o777).toBe(0o600);
		expect(readAuth().openai.key).toBe(NEW);
		expect(readAuth().other.key).toBe("x");
	});

	it("does not save the key when the permissions cannot be restricted", async () => {
		seed({});
		fs.chmodSync(authFile(), 0o644);
		vi.spyOn(fs, "chmodSync").mockImplementation(() => {
			throw Object.assign(new Error("not owner"), { code: "EPERM" });
		});
		const error = await failure(run(set("openai", NEW, { acknowledgePlaintext: true }), null));
		expect(error.code).toBe("permissions");
		expect(fs.readFileSync(authFile(), "utf8")).not.toContain(NEW);
	});
});
