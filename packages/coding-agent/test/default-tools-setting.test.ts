import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { createSessionFromServices } from "../src/core/agent-session/create-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { InlineExtension } from "../src/core/features/index.ts";
import { createTestSession } from "./helpers/session.ts";
import { publishRoles, RESEARCH, RESEARCH_ENTRY } from "./octocode/fake-research-roles.ts";
import type { CreateTestSessionOptions } from "./helpers/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Octocode's only core tool is `bash`. These inactive extension tools stand in for further built-in tools: a
 * `defaultTools` entry, `--tools` or a recorded loadout activates them by name like any registered tool.
 */
const extraTools: InlineExtension = (api) => {
	for (const name of ["alpha", "beta", "gamma"]) {
		api.registerTool({
			name,
			label: name,
			description: `Extra tool ${name}`,
			promptSnippet: `Extra tool ${name}`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			defaultActive: false,
		});
	}
};

type ToolOptions = Pick<CreateTestSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `octocode-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		defaultTools: string[] | undefined,
		options: ToolOptions = {},
		extensionFactories: InlineExtension[] = [],
		nativeFeatures = false,
	) {
		const settingsManager = SettingsManager.inMemory({ defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			nativeFeatures,
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		return (
			await createTestSession({
				cwd: tempDir,
				agentDir,
				model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["alpha", "beta"], {}, [extraTools]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["alpha", "bash", "beta", "gamma"]);
		expect(session.getActiveToolNames()).toEqual(["alpha", "beta"]);
		expect(session.systemPrompt).toContain("- alpha:");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("applies explicit tool selections to native features while preserving user extension tools", async () => {
		const extension: InlineExtension = (api) => {
			api.registerTool({
				name: "user_tool",
				label: "User tool",
				description: "A user extension tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			});
		};
		for (const options of [{}, { noTools: "builtin" as const }, { tools: ["file"] }]) {
			const session = await createSession(["file"], options, [extension], true);
			try {
				expect(session.getAllTools().map((tool) => tool.name)).toContain("file");
				expect(session.getActiveToolNames().sort()).toEqual(
					options.tools ? ["file"] : options.noTools ? ["user_tool"] : ["file", "user_tool"],
				);
			} finally {
				session.dispose();
			}
		}
	});

	it("ignores the retired graph tool names in saved defaults and in --tools", async () => {
		for (const options of [{}, { tools: ["file", "graphBuild", "graphQuery"] }]) {
			const session = await createSession(["file", "graphBuild", "graphQuery"], options, [], true);
			try {
				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("graphQuery");
				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("graphBuild");
				expect(session.getActiveToolNames()).toEqual(["file"]);
				expect(session.systemPrompt).not.toMatch(/graphBuild|graphQuery/);
			} finally {
				session.dispose();
			}
		}
	});

	it("does not treat `task` as the name of any tool: a selection that names it selects nothing", async () => {
		const cases: Array<[string[], ToolOptions, string[]]> = [
			[["file", "task"], {}, ["file"]],
			[["file", "+task"], {}, ["file"]],
			[["file"], { tools: ["file", "task"] }, ["file"]],
			[["file", "backlog"], { tools: ["-task"] }, ["backlog", "file"]],
			[["file", "backlog"], { excludeTools: ["task"] }, ["backlog", "file"]],
		];
		for (const [defaults, options, active] of cases) {
			const session = await createSession(defaults, options, [], true);
			try {
				expect(session.getAllTools().map((tool) => tool.name)).not.toContain("task");
				expect(session.getActiveToolNames().sort(), JSON.stringify([defaults, options])).toEqual(active);
				expect(session.getToolDefinition("task")).toBeUndefined();
			} finally {
				session.dispose();
			}
		}
	});

	it.each([
		// Browsing is the built-in browser MCP server; the native `browser` tool is retired, so `+browser` adds nothing.
		{ defaults: undefined, options: {}, expected: ["web"] },
		{ defaults: ["-browser"], options: {}, expected: ["web"] },
		{ defaults: ["+browser"], options: {}, expected: ["web"] },
		{ defaults: ["-web"], options: {}, expected: [] },
		{ defaults: undefined, options: { excludeTools: ["browser", "web"] }, expected: [] },
		{ defaults: undefined, options: { tools: ["file"] }, expected: [] },
	])(
		"activates web by default, never a native browser, and preserves selections through startup: %j",
		async ({ defaults, options, expected }) => {
			const session = await createSession(defaults, options, [], true);
			try {
				await session.bindExtensions({});
				expect(
					session
						.getActiveToolNames()
						.filter((name) => ["browser", "web"].includes(name))
						.sort(),
				).toEqual(expected);
				if (!options.tools) expect(session.getActiveToolNames()).toContain("agent");
				expect(session.agent.state.tools.some((tool) => tool.name === "browser")).toBe(false);
				await session.reload();
				expect(
					session
						.getActiveToolNames()
						.filter((name) => ["browser", "web"].includes(name))
						.sort(),
				).toEqual(expected);
			} finally {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		},
	);

	it.each([{ tools: ["file", "web"] }, { tools: ["agent", "archive"] }])(
		"retains SDK selected native tools after session startup: $tools",
		async ({ tools }) => {
			const session = await createSession([], { tools }, [], true);
			try {
				await session.bindExtensions({});
				// `agent` brings its companion `timer` (docs/native-features.md, companionTools).
				const companions = tools.includes("agent") ? ["wait"] : [];
				expect(session.getActiveToolNames().sort()).toEqual([...tools, ...companions].sort());
			} finally {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		},
	);

	it.each([
		{},
		{
			tools: [
				"read",
				"file",
				"powershell",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"coordinate",
				"sendMessage",
				"externalAgent",
			],
		},
	])("does not register removed native tools, including after reload: %j", async (options) => {
		const session = await createSession(["file"], options, [], true);
		try {
			for (let pass = 0; pass < 2; pass++) {
				const names = session.getAllTools().map((tool) => tool.name);
				for (const name of [
					"read",
					"powershell",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"externalAgent",
					"coordinate",
					"sendMessage",
				])
					expect(names).not.toContain(name);
				expect(session.getActiveToolNames().sort()).toEqual(["file"]);
				expect(session.systemPrompt).toContain("- file:");
				expect(session.systemPrompt).not.toContain("- edit:");
				if (pass === 0) await session.reload();
			}
		} finally {
			session.dispose();
		}
	});

	it("credits a reader-role MCP fetch through the session event pipeline before a guarded edit", async () => {
		const file = join(tempDir, "source.txt");
		writeFileSync(file, "before\n");
		// The tool reads workspace files because its server's entry declares it a reader, not because of its name.
		const name = RESEARCH.reader;
		const session = await createSession(
			["file"],
			{},
			[
				(api) =>
					api.registerTool({
						name,
						label: "read_file",
						description: "Read a source file",
						parameters: Type.Object({ queries: Type.Array(Type.Object({ path: Type.String() })) }),
						annotations: { readOnlyHint: true, openWorldHint: false },
						execute: async () => ({ content: [], details: {} }),
					}),
			],
			true,
		);
		try {
			await session.bindExtensions({});
			publishRoles([RESEARCH_ENTRY]);
			const input = { queries: [{ path: file }] };
			const blocked = await session.extensionRunner.emitToolCall({
				type: "tool_call",
				toolName: name,
				toolCallId: "fetch",
				input,
			});
			expect(blocked?.block).not.toBe(true);
			const structuredContent = { results: [{ data: { path: file, content: "1\tbefore\n", totalLines: 1 } }] };
			const result = await session.extensionRunner.emitToolResult({
				type: "tool_result",
				toolName: name,
				toolCallId: "fetch",
				input,
				content: [{ type: "text", text: JSON.stringify(structuredContent) }],
				details: {},
				structuredContent,
				isError: false,
			});
			expect(result?.details).toMatchObject({ localReads: [{ whole: true }] });
			const edit = session.agent.state.tools.find((tool) => tool.name === "file")!;
			await edit.execute("edit", {
				queries: [
					{
						type: "edit",
						path: file,
						reason: "Update the fixture",
						edits: [{ oldText: "before", newText: "after" }],
					},
				],
			});
			expect(readFileSync(file, "utf8")).toBe("after\n");
		} finally {
			publishRoles([]);
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("activates an inactive extension tool with +name", async () => {
		const session = await createSession(["+inactive_tool"], {}, [
			(api) => {
				api.registerTool({
					name: "inactive_tool",
					label: "Inactive Tool",
					description: "Extension tool registered inactive",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					defaultActive: false,
				});
			},
		]);

		expect(session.getActiveToolNames().sort()).toEqual(["bash", "inactive_tool"]);
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["bash"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				(api) => {
					api.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					api.on("session_start", () => {
						api.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		await session.bindExtensions({});

		expect(session.getActiveToolNames().sort()).toEqual(["bash", "dynamic_tool", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["bash", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["bash"], { tools: ["alpha"] }, [extraTools]);
		expect(allowlistedSession.getActiveToolNames()).toEqual(["alpha"]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["bash", "alpha"], { excludeTools: ["bash"] }, [extraTools]);
		expect(excludedSession.getActiveToolNames()).toEqual(["alpha"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["bash"], { noTools: "all" });
		expect(toolLessSession.getAllTools()).toEqual([]);
		expect(toolLessSession.getActiveToolNames()).toEqual([]);
		toolLessSession.dispose();
	});

	it("applies +name and -name tool options to the default selection", async () => {
		const inactiveTool: InlineExtension = (api) => {
			api.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			api.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		const session = await createSession(["+alpha"], { tools: ["+inactive_tool", "-beta"] }, [inactiveTool, extraTools]);
		expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "alpha", "bash", "inactive_tool"]);
		session.dispose();

		const removing = await createSession(["+alpha", "+beta"], { tools: ["-bash", "-alpha"] }, [
			inactiveTool,
			extraTools,
		]);
		expect(removing.getActiveToolNames().sort()).toEqual(["active_tool", "beta"]);
		removing.dispose();

		const toolLess = await createSession(["bash"], { noTools: "all", tools: ["+inactive_tool"] }, [inactiveTool]);
		expect(toolLess.getActiveToolNames()).toEqual(["inactive_tool"]);
		toolLess.dispose();
	});

	it("rejects invalid tool modifier options", async () => {
		await expect(createSession([], { tools: ["read", "+grep"] })).rejects.toThrow(
			"Invalid tools option: tool names cannot be mixed with +name or -name entries",
		);
		await expect(createSession([], { tools: ["-gr*"] })).rejects.toThrow(
			"Invalid tools option: +name and -name entries take exact tool names, not patterns: -gr*",
		);
	});

	describe("reload", () => {
		const inactiveTool: InlineExtension = (api) => {
			api.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
		};

		const writeSettings = (settings: object) =>
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

		async function createFileSession(options: ToolOptions = {}) {
			const settingsManager = SettingsManager.create(tempDir, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				nativeFeatures: false,
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [inactiveTool, extraTools],
			});
			await resourceLoader.reload();
			return (
				await createTestSession({
					cwd: tempDir,
					agentDir,
					model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
					settingsManager,
					sessionManager: SessionManager.inMemory(tempDir),
					resourceLoader,
					...options,
				})
			).session;
		}

		it("activates only tools newly added to defaultTools", async () => {
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toEqual(["bash"]);
			session.setActiveToolsByName(["beta"]);

			writeSettings({ defaultTools: ["+inactive_tool", "+alpha"] });
			await session.reload();
			// bash was disabled during the session and is not newly added, so it stays off.
			expect(session.getActiveToolNames().sort()).toEqual(["alpha", "beta", "inactive_tool"]);

			// Removing tools from the setting does not disable them.
			writeSettings({ defaultTools: ["-alpha"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["alpha", "beta", "inactive_tool"]);
			session.dispose();
		});

		it("keeps tools removed by -name tool options removed on reload", async () => {
			writeSettings({ defaultTools: ["alpha"] });
			const session = await createFileSession({ tools: ["-alpha", "+beta"] });
			expect(session.getActiveToolNames()).toEqual(["beta"]);

			writeSettings({ defaultTools: ["alpha", "bash", "inactive_tool"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["bash", "beta", "inactive_tool"]);
			session.dispose();
		});

		it("keeps explicit tool options on reload", async () => {
			const allowlisted = await createFileSession({ tools: ["bash"] });
			writeSettings({ defaultTools: ["+alpha"] });
			await allowlisted.reload();
			expect(allowlisted.getActiveToolNames()).toEqual(["bash"]);
			allowlisted.dispose();

			writeSettings({});
			const builtinless = await createFileSession({ noTools: "builtin" });
			writeSettings({ defaultTools: ["+alpha"] });
			await builtinless.reload();
			expect(builtinless.getActiveToolNames()).toEqual([]);
			builtinless.dispose();

			writeSettings({});
			const excluded = await createFileSession({ excludeTools: ["alpha"] });
			writeSettings({ defaultTools: ["+alpha", "+inactive_tool"] });
			await excluded.reload();
			expect(excluded.getActiveToolNames().sort()).toEqual(["bash", "inactive_tool"]);
			excluded.dispose();
		});
	});

	describe("resume", () => {
		const extensionTools: InlineExtension = (api) => {
			api.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			api.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		/** A session whose transcript records the loadout `toolNames`, as a run records it. */
		function createRecordedSession(toolNames: string[]): SessionManager {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({
				role: "system",
				content: "",
				toolsAdded: toolNames.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
				timestamp: Date.now(),
			});
			return sessionManager;
		}

		async function resume(sessionManager: SessionManager, options: ToolOptions = {}) {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				nativeFeatures: false,
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [extensionTools, extraTools],
			});
			await resourceLoader.reload();
			return (
				await createTestSession({
					cwd: tempDir,
					agentDir,
					model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
					settingsManager,
					sessionManager,
					resourceLoader,
					...options,
				})
			).session;
		}

		it("restores the loadout the transcript records", async () => {
			// active_tool was deactivated during the session, inactive_tool activated.
			const session = await resume(createRecordedSession(["bash", "alpha", "inactive_tool"]));
			expect(session.getActiveToolNames().sort()).toEqual(["alpha", "bash", "inactive_tool"]);
			session.dispose();
		});

		it("does not restore excluded tools", async () => {
			const session = await resume(createRecordedSession(["bash", "alpha", "inactive_tool"]), {
				excludeTools: ["inactive_tool"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["alpha", "bash"]);
			session.dispose();
		});

		it("uses explicit tool options instead of the recorded loadout", async () => {
			const recorded = ["bash", "alpha", "inactive_tool"];

			const allowlisted = await resume(createRecordedSession(recorded), { tools: ["bash", "beta"] });
			expect(allowlisted.getActiveToolNames()).toEqual(["bash", "beta"]);
			allowlisted.dispose();

			const builtinless = await resume(createRecordedSession(recorded), { noTools: "builtin" });
			expect(builtinless.getActiveToolNames()).toEqual(["active_tool"]);
			builtinless.dispose();
		});

		it("applies +name and -name tool options to the recorded loadout", async () => {
			const session = await resume(createRecordedSession(["bash", "alpha", "inactive_tool"]), {
				tools: ["-alpha", "+beta"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["bash", "beta", "inactive_tool"]);
			session.dispose();
		});

		it("uses the default tools when the transcript records no loadout", async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
			const session = await resume(sessionManager);
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash"]);
			session.dispose();
		});
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["alpha"] });
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { nativeFeatures: false, extensionFactories: [extraTools] },
		});
		const { session } = await createSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["alpha", "bash", "beta", "gamma"]);
		expect(session.getActiveToolNames()).toEqual(["alpha"]);
		session.dispose();
	});
});
