import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeychainBackend } from "../src/core/auth-storage/keychain.ts";
import { moveKeyToKeychain } from "../src/modes/interactive/interactive-mode/provider-move-key.ts";

const SECRET = "sk-literal-secret-value";
let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "move-key-"));
	file = join(dir, "models.json");
	writeFileSync(
		file,
		JSON.stringify({
			providers: { gw: { baseUrl: "http://x/v1", api: "openai-completions", apiKey: SECRET, models: [{ id: "m" }] } },
		}),
	);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function backend(): KeychainBackend & { entries: Map<string, string> } {
	const entries = new Map<string, string>();
	return {
		name: "test keychain",
		entries,
		store: async (account, secret) => void entries.set(account, secret),
		remove: async (account) => void entries.delete(account),
		referenceFor: (account) => `!read-key ${account}`,
		isOwnReference: (key, account) => key === `!read-key ${account}`,
	};
}

function host() {
	return {
		session: { modelRuntime: { refresh: vi.fn(async () => {}) } },
		showStatus: vi.fn(),
		showError: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
	};
}

describe("move key to keychain", () => {
	it("stores the key, swaps in the reference and never prints the key", async () => {
		const ui = host();
		const keychain = backend();
		expect(await moveKeyToKeychain(ui as never, "gw", "Gateway", file, keychain, [file])).toBe(true);
		expect(keychain.entries.get("gw.models")).toBe(SECRET);
		const written = readFileSync(file, "utf8");
		expect(written).not.toContain(SECRET);
		expect(JSON.parse(written).providers.gw.apiKey).toBe("!read-key gw.models");
		expect(JSON.parse(written).providers.gw.models).toEqual([{ id: "m" }]);
		expect(ui.session.modelRuntime.refresh).toHaveBeenCalled();
		expect(JSON.stringify([ui.showStatus.mock.calls, ui.showError.mock.calls])).not.toContain(SECRET);
	});

	it("explains when no OS store exists and leaves the file alone", async () => {
		const ui = host();
		expect(await moveKeyToKeychain(ui as never, "gw", "Gateway", file, null, [file])).toBe(false);
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining("No system keychain"));
		expect(readFileSync(file, "utf8")).toContain(SECRET);
	});

	it("keeps the literal key and deletes no keychain entry when models.json changed meanwhile", async () => {
		const ui = host();
		const keychain = backend();
		const store = keychain.store;
		keychain.store = async (account, secret) => {
			await store(account, secret);
			writeFileSync(
				file,
				JSON.stringify({ providers: { gw: { baseUrl: "http://x/v1", apiKey: "other", models: [{ id: "m" }] } } }),
			);
		};
		keychain.entries.set("other.models", "kept");
		expect(await moveKeyToKeychain(ui as never, "gw", "Gateway", file, keychain, [file])).toBe(false);
		// The key-changed guard refused the rewrite: the file is untouched and no entry was removed.
		expect(JSON.parse(readFileSync(file, "utf8")).providers.gw.apiKey).toBe("other");
		expect(keychain.entries.get("other.models")).toBe("kept");
		expect(keychain.entries.get("gw.models")).toBe(SECRET);
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining("stays in"));
		expect(JSON.stringify(ui.showError.mock.calls)).not.toContain(SECRET);
	});

	it("refuses when another models.json already reads the keychain entry it would replace", async () => {
		const ui = host();
		const keychain = backend();
		keychain.entries.set("gw.models", "earlier-secret");
		const other = join(dir, "pi-models.json");
		writeFileSync(other, JSON.stringify({ providers: { gw: { apiKey: "!read-key gw.models" } } }));
		expect(await moveKeyToKeychain(ui as never, "gw", "Gateway", file, keychain, [file, other])).toBe(false);
		expect(keychain.entries.get("gw.models")).toBe("earlier-secret");
		expect(readFileSync(file, "utf8")).toContain(SECRET);
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining(other));
	});

	it("reports a failed reload after a successful move without claiming the key stayed", async () => {
		const ui = host();
		ui.session.modelRuntime.refresh = vi.fn(async () => {
			throw new Error("boom");
		});
		expect(await moveKeyToKeychain(ui as never, "gw", "Gateway", file, backend(), [file])).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8")).providers.gw.apiKey).toBe("!read-key gw.models");
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining("run /reload"));
	});
});
