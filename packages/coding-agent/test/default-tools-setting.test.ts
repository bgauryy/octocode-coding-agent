import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["grep", "find"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["grep", "find"]);
		expect(session.systemPrompt).toContain("- grep:");
		expect(session.systemPrompt).not.toContain("- read:");
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

	it.each([
		{ defaults: undefined, options: {}, expected: ["web"] },
		{ defaults: ["-browser"], options: {}, expected: ["web"] },
		{ defaults: ["+browser"], options: {}, expected: ["browser", "web"] },
		{ defaults: ["-web"], options: {}, expected: [] },
		{ defaults: undefined, options: { excludeTools: ["browser", "web"] }, expected: [] },
		{ defaults: undefined, options: { tools: ["file"] }, expected: [] },
	])(
		"keeps browser opt-in and preserves web defaults and exclusions through startup: %j",
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
				expect(session.agent.state.tools.some((tool) => tool.name === "browser")).toBe(
					expected.some((name) => name === "browser"),
				);
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

	it.each([{ tools: ["file", "web"] }, { tools: ["agent", "browser"] }])(
		"retains SDK selected native tools after session startup: $tools",
		async ({ tools }) => {
			const session = await createSession([], { tools }, [], true);
			try {
				await session.bindExtensions({});
				expect(session.getActiveToolNames().sort()).toEqual([...tools].sort());
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

	it("credits an MCP fetch through the session event pipeline before a guarded edit", async () => {
		const file = join(tempDir, "source.txt");
		writeFileSync(file, "before\n");
		const name = "mcp__octocode__localFetch";
		const session = await createSession(
			["file"],
			{},
			[
				(pi) =>
					pi.registerTool({
						name,
						label: "localFetch",
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
						reasoning: "Update the fixture",
						edits: [{ oldText: "before", newText: "after" }],
					},
				],
			});
			expect(readFileSync(file, "utf8")).toBe("after\n");
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("can select powershell instead of bash", async () => {
		const session = await createSession(["read", "powershell", "edit", "write"]);

		expect(session.getActiveToolNames()).toEqual(["read", "powershell", "edit", "write"]);
		expect(session.systemPrompt).toContain("- powershell: Execute PowerShell commands");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("activates an inactive extension tool with +name", async () => {
		const session = await createSession(["+inactive_tool", "-write"], {}, [
			(pi) => {
				pi.registerTool({
					name: "inactive_tool",
					label: "Inactive Tool",
					description: "Extension tool registered inactive",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					defaultActive: false,
				});
			},
		]);

		expect(session.getActiveToolNames().sort()).toEqual(["bash", "edit", "inactive_tool", "read"]);
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["grep"],
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
				(pi) => {
					pi.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("session_start", () => {
						pi.registerTool({
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

		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "grep", "sdk_tool", "static_tool"]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["grep"], { tools: ["read"] });
		expect(allowlistedSession.getActiveToolNames()).toEqual(["read"]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["read", "grep"], { excludeTools: ["read"] });
		expect(excludedSession.getActiveToolNames()).toEqual(["grep"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		expect(toolLessSession.getAllTools()).toEqual([]);
		expect(toolLessSession.getActiveToolNames()).toEqual([]);
		toolLessSession.dispose();
	});

	it("applies +name and -name tool options to the default selection", async () => {
		const inactiveTool: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			pi.registerTool({
				name: "active_tool",
				label: "Active Tool",
				description: "Extension tool registered active",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};

		const session = await createSession(["+grep"], { tools: ["+inactive_tool", "-write"] }, [inactiveTool]);
		expect(session.getActiveToolNames().sort()).toEqual([
			"active_tool",
			"bash",
			"edit",
			"grep",
			"inactive_tool",
			"read",
		]);
		session.dispose();

		const toolLess = await createSession(["read"], { noTools: "all", tools: ["+inactive_tool"] }, [inactiveTool]);
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
		const inactiveTool: InlineExtension = (pi) => {
			pi.registerTool({
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
				extensionFactories: [inactiveTool],
			});
			await resourceLoader.reload();
			return (
				await createAgentSession({
					cwd: tempDir,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager: SessionManager.inMemory(tempDir),
					resourceLoader,
					...options,
				})
			).session;
		}

		// #10245
		it("activates only tools newly added to defaultTools", async () => {
			const session = await createFileSession();
			expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			session.setActiveToolsByName(["read", "edit", "write"]);

			writeSettings({ defaultTools: ["+inactive_tool", "+grep"] });
			await session.reload();
			// bash was disabled during the session and is not newly added, so it stays off.
			expect(session.getActiveToolNames().sort()).toEqual(["edit", "grep", "inactive_tool", "read", "write"]);

			// Removing tools from the setting does not disable them.
			writeSettings({ defaultTools: ["-read"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["edit", "grep", "inactive_tool", "read", "write"]);
			session.dispose();
		});

		it("keeps tools removed by -name tool options removed on reload", async () => {
			writeSettings({ defaultTools: ["read"] });
			const session = await createFileSession({ tools: ["-bash", "+grep"] });
			expect(session.getActiveToolNames()).toEqual(["read", "grep"]);

			writeSettings({ defaultTools: ["read", "bash", "inactive_tool"] });
			await session.reload();
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "inactive_tool", "read"]);
			session.dispose();
		});

		it("keeps explicit tool options on reload", async () => {
			const allowlisted = await createFileSession({ tools: ["read"] });
			writeSettings({ defaultTools: ["+grep"] });
			await allowlisted.reload();
			expect(allowlisted.getActiveToolNames()).toEqual(["read"]);
			allowlisted.dispose();

			writeSettings({});
			const builtinless = await createFileSession({ noTools: "builtin" });
			writeSettings({ defaultTools: ["+grep"] });
			await builtinless.reload();
			expect(builtinless.getActiveToolNames()).toEqual([]);
			builtinless.dispose();

			writeSettings({});
			const excluded = await createFileSession({ excludeTools: ["grep"] });
			writeSettings({ defaultTools: ["+grep", "+inactive_tool"] });
			await excluded.reload();
			expect(excluded.getActiveToolNames().sort()).toEqual(["bash", "edit", "inactive_tool", "read", "write"]);
			excluded.dispose();
		});
	});

	// #10785
	describe("resume", () => {
		const extensionTools: InlineExtension = (pi) => {
			pi.registerTool({
				name: "inactive_tool",
				label: "Inactive Tool",
				description: "Extension tool registered inactive",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				defaultActive: false,
			});
			pi.registerTool({
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
				extensionFactories: [extensionTools],
			});
			await resourceLoader.reload();
			return (
				await createAgentSession({
					cwd: tempDir,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					settingsManager,
					sessionManager,
					resourceLoader,
					...options,
				})
			).session;
		}

		it("restores the loadout the transcript records", async () => {
			// active_tool was deactivated during the session, inactive_tool activated.
			const session = await resume(createRecordedSession(["read", "grep", "inactive_tool"]));
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "inactive_tool", "read"]);
			session.dispose();
		});

		it("does not restore excluded tools", async () => {
			const session = await resume(createRecordedSession(["read", "grep", "inactive_tool"]), {
				excludeTools: ["inactive_tool"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["grep", "read"]);
			session.dispose();
		});

		it("uses explicit tool options instead of the recorded loadout", async () => {
			const recorded = ["read", "grep", "inactive_tool"];

			const allowlisted = await resume(createRecordedSession(recorded), { tools: ["read", "write"] });
			expect(allowlisted.getActiveToolNames()).toEqual(["read", "write"]);
			allowlisted.dispose();

			const builtinless = await resume(createRecordedSession(recorded), { noTools: "builtin" });
			expect(builtinless.getActiveToolNames()).toEqual(["active_tool"]);
			builtinless.dispose();
		});

		it("applies +name and -name tool options to the recorded loadout", async () => {
			const session = await resume(createRecordedSession(["read", "grep", "inactive_tool"]), {
				tools: ["-grep", "+write"],
			});
			expect(session.getActiveToolNames().sort()).toEqual(["inactive_tool", "read", "write"]);
			session.dispose();
		});

		it("uses the default tools when the transcript records no loadout", async () => {
			const sessionManager = SessionManager.inMemory(tempDir);
			sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
			const session = await resume(sessionManager);
			expect(session.getActiveToolNames().sort()).toEqual(["active_tool", "bash", "edit", "read", "write"]);
			session.dispose();
		});
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["ls"] });
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: { nativeFeatures: false },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["ls"]);
		session.dispose();
	});
});
