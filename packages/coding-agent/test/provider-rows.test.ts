import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir, getModelsPath } from "../src/config.ts";
import { homeTilde } from "../../common/src/home-tilde.ts";
import type { AuthStatus } from "../src/core/provider-composer/types.ts";
import { buildProviderSnapshot } from "../src/core/provider-view/snapshot.ts";
import { providerRows } from "../src/modes/interactive/interactive-mode/provider-rows.ts";

interface Options {
	status: AuthStatus;
	file?: string;
	defined?: boolean;
	saved?: boolean;
	models?: number;
	disabled?: boolean;
}

async function groupsFor(options: Options) {
	const defined = options.defined !== false;
	const runtime = {
		getProviders: () => (defined ? [{ id: "p", name: "P" }] : []),
		getProvider: () => (defined ? { id: "p", name: "P" } : undefined),
		getProviderKind: () => "account",
		getProviderAuthStatus: () => options.status,
		hasConfiguredAuth: () => options.status.configured,
		getAvailableSnapshot: () => Array.from({ length: options.models ?? 1 }, () => ({ provider: "p" })),
		getPlanDisabledReason: () => undefined,
		getProviderDefinitionFile: () => options.file,
		listCredentials: async () => (options.saved === false ? [] : [{ providerId: "p", type: "api_key" }]),
		readCredential: async () => undefined,
		getAuth: async () => undefined,
	};
	const snapshot = await buildProviderSnapshot({
		runtime: runtime as never,
		disabledProviders: options.disabled ? ["p"] : [],
	});
	return { groups: providerRows(snapshot), snapshot };
}

async function rowFor(options: Options) {
	const { groups } = await groupsFor(options);
	return [...groups.ready, ...groups.attention, ...groups.off][0];
}

describe("provider row sources", () => {
	const authFile = homeTilde(join(getAgentDir(), "auth.json"));

	it("names the definition file and the apiKey it holds", async () => {
		const file = join(getAgentDir(), "models.json");
		const detail = (await rowFor({ status: { configured: true, source: "models_json_key" }, file })).detail;
		expect(detail).toContain(`apiKey in ${homeTilde(file)}`);
		expect(detail).toContain(`defined in ${homeTilde(file)}`);
	});

	it("says built-in and names the auth file, keychain or variable", async () => {
		expect((await rowFor({ status: { configured: true, source: "stored", label: "auth.json" } })).detail).toContain(
			`${authFile} · defined in built-in`,
		);
		expect((await rowFor({ status: { configured: true, source: "stored", label: "keychain" } })).detail).toContain(
			`keychain (${authFile})`,
		);
		expect(
			(await rowFor({ status: { configured: true, source: "environment", label: "OPENAI_API_KEY" } })).detail,
		).toContain("OPENAI_API_KEY");
	});

	it("names Pi's auth file for a fallback credential", async () => {
		const label = "saved credential in ~/.pi/agent/auth.json";
		expect((await rowFor({ status: { configured: true, source: "stored", label } })).detail).toContain(
			" · ~/.pi/agent/auth.json",
		);
	});

	it("tells an orphan which file holds the credential, the cause and the fix", async () => {
		const { groups, snapshot } = await groupsFor({
			status: { configured: true, source: "stored", label: "auth.json" },
			defined: false,
		});
		const row = groups.attention[0];
		expect(row.badge).toBe("✗ broken");
		expect(row.detail).toContain(`credential in ${authFile} but no provider defines it`);
		expect(row.detail).toContain(`remove the credential, or define the provider in ${homeTilde(getModelsPath())}`);
		expect(snapshot.entry("p")?.nextStep?.action).toBe("remove");
	});

	it("lists a provider its own models.json defines without a key under Needs attention", async () => {
		const file = join(getAgentDir(), "models.json");
		const { groups } = await groupsFor({ status: { configured: false }, file, saved: false });
		expect(groups.ready).toEqual([]);
		expect(groups.attention).toHaveLength(1);
		expect(groups.attention[0].detail).toMatch(
			/needs key · no credential · add a key, or set its environment variable/,
		);
		expect(groups.attention[0].badge).toBe("⚠ needs action");
	});

	it("does not list a built-in provider that has no credential", async () => {
		const { groups, snapshot } = await groupsFor({ status: { configured: false }, saved: false });
		expect(groups.attention).toEqual([]);
		expect(snapshot.entry("p")?.state).toBe("needs-key");
	});

	it("puts a disabled provider under Off", async () => {
		const row = await rowFor({ status: { configured: true, source: "environment", label: "K" }, disabled: true });
		expect(row.badge).toBe("○ off");
		expect(row.keys).toEqual({ e: "enable" });
	});

	it("declares the enable/disable key on provider rows only", async () => {
		const row = await rowFor({ status: { configured: true, source: "environment", label: "K" } });
		expect(row.keys).toEqual({ e: "disable" });
	});
});
