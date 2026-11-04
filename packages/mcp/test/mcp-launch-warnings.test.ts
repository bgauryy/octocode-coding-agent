import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigValueOrThrow } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { hostPaths, installMcpHost, type McpPathsPort } from "../src/host.ts";
import type { McpServerEntry } from "../src/config.ts";
import { expandLaunchTemplates } from "../src/launch-templates.ts";
import { recommendedPresets } from "../src/recommended/index.ts";
import { takeLaunchWarnings } from "../src/warnings.ts";

const original = hostPaths();
const withRoots = (researchRoots: McpPathsPort["researchRoots"]) =>
	installMcpHost({ paths: { ...original, researchRoots } });
afterEach(() => installMcpHost({ paths: original }));

const entry = (env: Record<string, string>, args: string[] = []): McpServerEntry => ({
	name: "research",
	config: { command: "server", args, env },
	source: "test",
	scope: "global",
});
const envOf = (prepared: McpServerEntry) => (prepared.config as { env: Record<string, string> }).env;

const allowed = (): string[] => {
	const prepared = expandLaunchTemplates(entry({ ROOTS: "${researchRoots}" }), {
		cwd: "/work/app",
		projectTrusted: true,
		skillDirectories: ["/skills/one"],
	});
	return resolveConfigValueOrThrow(envOf(prepared).ROOTS, "ROOTS").split(",");
};

describe("launch templates", () => {
	it("${researchRoots}: the automatic roots without the host's port", () => {
		withRoots(undefined);
		expect(allowed()).toEqual(["/work/app", ...original.sessionRoots("/work/app"), "/skills/one"]);
	});

	it("${researchRoots}: the port's roots after the automatic ones, its warnings queued once", () => {
		const warning = `Allowed folder "rel" ${Math.random()} is not absolute; ignored.`;
		withRoots(() => ({ roots: ["/user/a", "/skills/one"], warnings: [warning] }));
		expect(allowed()).toEqual(["/work/app", ...original.sessionRoots("/work/app"), "/skills/one", "/user/a"]);
		allowed();
		expect(takeLaunchWarnings()).toEqual([warning]);
		expect(takeLaunchWarnings()).toEqual([]);
	});

	it("expands agentDir, projectTrusted and workspace in env and args, keeping values literal", () => {
		const prepared = expandLaunchTemplates(
			entry({ DIR: "${agentDir}", TRUST: "${projectTrusted}", HOME_REF: "${HOME}", KEEP: "$${workspace}" }, [
				"--root=${workspace}",
			]),
			{ cwd: "/no/such/$dir", projectTrusted: false },
		);
		const env = envOf(prepared);
		expect(resolveConfigValueOrThrow(env.DIR, "DIR")).toBe(original.agentDir());
		expect(env.TRUST).toBe("false");
		expect(env.HOME_REF).toBe("${HOME}");
		expect(env.KEEP).toBe("$${workspace}");
		expect((prepared.config as { args: string[] }).args).toEqual(["--root=/no/such/$dir"]);
	});

	it("${untrusted:false}: sets the env var in an untrusted project and omits it in a trusted one", () => {
		const lsp = entry({ TRUST_LSP: "${untrusted:false}", KEEP: "a" });
		const untrusted = envOf(expandLaunchTemplates(lsp, { cwd: "/w", projectTrusted: false }));
		expect(untrusted).toEqual({ TRUST_LSP: "false", KEEP: "a" });
		const trusted = envOf(expandLaunchTemplates(lsp, { cwd: "/w", projectTrusted: true }));
		expect(trusted).toEqual({ KEEP: "a" });
		expect("TRUST_LSP" in trusted).toBe(false);
	});

	it("${untrusted:<value>}: drops a lone arg when trusted and expands to empty inside other text", () => {
		const flags = entry({}, ["--sandbox=${untrusted:strict}", "${untrusted:--no-lsp}", "--x"]);
		const argsOf = (projectTrusted: boolean) =>
			(expandLaunchTemplates(flags, { cwd: "/w", projectTrusted }).config as { args: string[] }).args;
		expect(argsOf(false)).toEqual(["--sandbox=strict", "--no-lsp", "--x"]);
		expect(argsOf(true)).toEqual(["--sandbox=", "--x"]);
	});

	it("recommended servers leave project LSP trust to the user's own setting in trusted projects", () => {
		for (const { name, config } of recommendedPresets({})) {
			const recommended: McpServerEntry = { name, config: config!, source: "default", scope: "default" };
			const trustOf = (projectTrusted: boolean) =>
				envOf(expandLaunchTemplates(recommended, { cwd: "/w", projectTrusted })).OCTOCODE_TRUST_PROJECT_LSP_CONFIG;
			expect(trustOf(true)).toBeUndefined();
			expect(trustOf(false)).toBe("false");
		}
	});

	it("rejects ${untrusted} without a value and a value on another template", () => {
		const run = (text: string) => () => expandLaunchTemplates(entry({ X: text }), { cwd: "/w", projectTrusted: false });
		expect(run("${untrusted}")).toThrow(/env "X": launch template \$\{untrusted:<value>\} needs a value/);
		expect(run("${workspace:x}")).toThrow(/env "X": launch template \$\{workspace\} takes no value/);
	});

	it("rejects an unknown template by name", () => {
		expect(() => expandLaunchTemplates(entry({ X: "${worksapce}" }), { cwd: "/w", projectTrusted: true })).toThrow(
			/MCP server "research" env "X": unknown launch template \$\{worksapce\}/,
		);
	});

	it("leaves an entry without templates as it is", () => {
		const plain = entry({ A: "b" });
		expect(expandLaunchTemplates(plain, { cwd: "/w", projectTrusted: true })).toBe(plain);
	});
});
