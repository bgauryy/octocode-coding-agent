import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { localResearchTools } from "../../src/octocode/subagents/core-tools.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";
import { sessionOption } from "../../src/octocode/permission/ask/text.ts";
import { buildAgentArgs } from "../../src/octocode/subagents/process/session.ts";
import {
	type AgentProfile,
	askSpawn,
	loadProfiles,
	parseProfile,
	profileReach,
	profileSelectsTool,
} from "../../src/octocode/subagents/profiles.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

useResearchRoles();

describe("profile selectors against native Octocode tool exposure", () => {
	const cases: Array<{ name: string; fields: Partial<AgentProfile>; defaults?: string[] }> = [
		{ name: "default tools", fields: {} },
		{ name: "unspecified child selector with read-only parent defaults", fields: {}, defaults: ["read"] },
		{ name: "all tools wildcard", fields: { tools: "*" } },
		{ name: "shell suffix wildcard", fields: { tools: "*sh" } },
		{ name: "native file tool wildcard", fields: { tools: "f*" } },
		{ name: "removed write tool wildcard", fields: { tools: "w*" } },
		{ name: "removed mutation tools", fields: { tools: "edit,write" } },
		{ name: "read only allowlist", fields: { tools: "read,grep" } },
		{ name: "restricted MCP allowlist", fields: { tools: "web,mcp__example__lookup" } },
		{ name: "empty allowlist", fields: { tools: ", " } },
		{ name: "empty relative removal", fields: { tools: "-" } },
		{ name: "wildcard exclusions", fields: { excludeTools: "web*,*sh" } },
		{ name: "extension tools with relative selectors", fields: { tools: "-web,-bash" } },
		{
			name: "relative child selector with read-only parent defaults",
			fields: { tools: "-bash" },
			defaults: ["read"],
		},
		{ name: "added native shell", fields: { tools: "+powershell", excludeTools: "browser,bash" } },
		{
			name: "removed configured native shell",
			fields: { tools: "-powershell", excludeTools: "browser,bash" },
			defaults: ["read", "powershell"],
		},
		{ name: "configured native shell", fields: { excludeTools: "browser,bash" }, defaults: ["powershell"] },
		{
			name: "ordered modifiers",
			fields: { tools: "+powershell,-powershell,+powershell", excludeTools: "browser,bash" },
		},
		{ name: "optional tools excluded", fields: { tools: "*", excludeTools: "web,browser" } },
	];
	for (const name of ["browser", "implementer", "researcher", "reviewer"]) {
		cases.push({
			name: `${name} with PowerShell defaults`,
			fields: loadProfiles(tmp(), tmp(), false, {}).get(name)!,
			defaults: ["read", "powershell"],
		});
	}

	it.each(cases)("$name", async ({ fields, defaults }) => {
		const cwd = tmp();
		const agentDir = path.join(cwd, "agent");
		fs.mkdirSync(agentDir);
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("OCTOCODE_MCP", "0");
		const profile = { name: "selection-test", description: "", prompt: "", ...fields };
		const args = parseArgs(
			buildAgentArgs(profile, undefined, {
				dir: path.join(cwd, "session"),
				id: "selection-test",
			}),
		);
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			...(defaults ? { defaultTools: defaults } : {}),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			disabledFeatures: ["mcp"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		let session: Awaited<ReturnType<typeof createTestSession>>["session"] | undefined;
		try {
			await resourceLoader.reload();
			({ session } = await createTestSession({
				cwd,
				agentDir,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [...localResearchTools(), "mcp__example__lookup", "mcp__other__lookup"].map((name) => ({
					name,
					label: name,
					description: name,
					defaultActive: false,
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				})),
				...(args.tools ? { tools: args.tools } : {}),
				...(args.excludeTools ? { excludeTools: args.excludeTools } : {}),
			}));
			const active = new Set(session.getActiveToolNames());
			expect([...active]).toEqual(
				expect.arrayContaining(["file", "agent", "wait", "archive", "memory", ...localResearchTools()]),
			);
			if (fields.tools === "web,mcp__example__lookup") {
				expect(active.has("mcp__example__lookup")).toBe(true);
				expect(active.has("mcp__other__lookup")).toBe(false);
			}
			if (fields.name === "browser") {
				expect(active.has("powershell")).toBe(false);
				// Read-only through the permission gate, not by lacking a shell.
				expect(active.has("bash")).toBe(true);
				expect(active.has("file")).toBe(true);
				expect(active.has("browser")).toBe(false);
			}
			if (
				(fields.tools === "-bash" || fields.tools === undefined) &&
				defaults?.length === 1 &&
				defaults[0] === "read"
			) {
				expect([...active]).toEqual(expect.arrayContaining(["agent", "wait", "archive", "memory"]));
				// Without a `-bash` entry the child gets the shell even when its parent's defaults have none.
				expect(active.has("bash")).toBe(fields.tools === undefined);
			}
			const nativeReach = [
				...(active.has("file") ? ["file.workspace"] : []),
				...(["bash", "powershell"].some((name) => active.has(name)) ? ["shell"] : []),
			];
			expect(profileReach(profile, defaults)).toEqual(nativeReach);
		} finally {
			session?.dispose();
			vi.unstubAllEnvs();
		}
	});

	it.each(["read,+bash", "+ba*", "-ba*", "read,+"])(
		"rejects invalid native selectors before asking: %s",
		async (tools) => {
			const parsed = parseArgs(["--tools", tools]);
			const nativeError = parsed.diagnostics.find((diagnostic) => diagnostic.type === "error")!.message;
			expect(() => parseProfile("invalid", `---\ntools: ${JSON.stringify(tools)}\n---\nTask`)).toThrow(nativeError);
			const permission = fakePermission();
			const check = vi.spyOn(permission, "check");
			await expect(
				askSpawn(permission, fakeCtx({ cwd: tmp() }), { name: "invalid", description: "", prompt: "", tools }, "task"),
			).rejects.toThrow(nativeError);
			expect(check).not.toHaveBeenCalled();
		},
	);
});

describe("the spawn grant for a session", () => {
	const text = (body: string, front = "") => `---\nname: worker\ndescription: Works\n${front}---\n${body}`;

	it("is keyed by the profile's content: an edit under the same name asks again, the same content does not", async () => {
		const permission = new Permission({
			api: fakeHost().api,
			env: { OCTOCODE_PERMISSION: "manual" },
			isSubagent: false,
		});
		const ctx = fakeCtx({ cwd: tmp() });
		permission.start(ctx);
		const grant = sessionOption("worker subagents");
		const asked: string[] = [];
		const replies = [grant, "Deny", "Deny", "Deny", "Deny"];
		ctx.ui.select = async (title: string) => {
			asked.push(title);
			return replies.shift();
		};
		const profile = parseProfile("worker", text("Fix it."));
		await askSpawn(permission, ctx, profile, "one");
		expect(asked).toHaveLength(1);
		// Allowed for the session: the same content passes without a dialog.
		await askSpawn(permission, ctx, parseProfile("worker", text("Fix it.")), "two");
		expect(asked).toHaveLength(1);
		// Any edit under the same name (prompt, model, tools, flags) is a new question; here each is refused.
		for (const edited of [
			text("Fix it, then deploy."),
			text("Fix it.", "model: small\n"),
			text("Fix it.", "tools: read,bash\n"),
			text("Fix it.", "hooks: true\n"),
		]) {
			await expect(askSpawn(permission, ctx, parseProfile("worker", edited), "three")).rejects.toThrow(
				/denied starting a subagent/,
			);
		}
		expect(asked).toHaveLength(5);
	});
});

describe("bundled roles", () => {
	it("preserves broad general defaults and the explicit lean escape", () => {
		const defaults = ["bash", "file"];
		for (const tool of defaults) expect(profileSelectsTool(undefined, tool, defaults), tool).toBe(true);
		const lean = loadProfiles(tmp(), tmp(), false, {}).get("lean");
		expect(lean?.lean).toBe(true);
		for (const tool of ["bash", "file"]) expect(profileSelectsTool(lean, tool, defaults), tool).toBe(true);
		expect(profileSelectsTool(lean, "agent", defaults), "agent").toBe(true);
		for (const tool of ["wait", "archive", "memory", "skill", "mcp"])
			expect(profileSelectsTool(lean, tool, defaults), tool).toBe(false);
	});

	it("gives every bundled role the research server's reader and search tools by role, nothing else of it", () => {
		const roles = loadProfiles(tmp(), tmp(), false, {});
		expect(localResearchTools()).toEqual([RESEARCH.reader, RESEARCH.search]);
		for (const name of ["researcher", "reviewer", "implementer"]) {
			for (const tool of [RESEARCH.reader, RESEARCH.search])
				expect(profileSelectsTool(roles.get(name), tool, ["bash"]), `${name} ${tool}`).toBe(true);
			for (const tool of [RESEARCH.readOnly, RESEARCH.other])
				expect(profileSelectsTool(roles.get(name), tool, ["bash"]), `${name} ${tool}`).toBe(false);
		}
	});

	it("keeps read-only roles read-only and the implementer unrestricted", () => {
		const roles = loadProfiles(tmp(), tmp(), false, {});
		for (const name of ["researcher", "reviewer", "implementer"])
			expect(roles.get(name)?.readOnly, name).toBe(name === "implementer" ? undefined : true);
	});

	it("lets a trusted profile override restore tools a bundled role excludes", () => {
		const cwd = tmp();
		const dir = path.join(cwd, ".octocode", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "reviewer.md"),
			"---\nname: reviewer\nexcludeTools: browser\nreadOnly: true\n---\nReview with a debugger.",
		);
		const profile = loadProfiles(cwd, tmp(), true, {}).get("reviewer");
		for (const tool of ["debug", "file", "agent", ...localResearchTools()])
			expect(profileSelectsTool(profile, tool, ["debug"]), tool).toBe(true);
	});

	it("treats the removed graph tool names in saved profiles and defaults as unknown tools, not errors", () => {
		const stale = ["graphBuild", "graphQuery"];
		const profile = parseProfile("stale", `---\nexcludeTools: ${stale.join(",")}\n---\nTask`);
		for (const tool of ["bash", "file"])
			expect(profileSelectsTool(profile, tool, ["bash", "file", ...stale]), tool).toBe(true);
	});
});
