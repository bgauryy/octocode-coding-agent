import fs from "node:fs";
import { spawn } from "node:child_process";
import { getCliInvocation } from "../../src/config.ts";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type JsonObject,
} from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
	const root = tmp("child-skill-inheritance-"),
		cwd = path.join(root, "project"),
		home = path.join(root, "home"),
		agentDir = path.join(root, "agent");
	for (const dir of [cwd, home, agentDir]) fs.mkdirSync(dir);
	const requests: JsonObject[] = [];
	let readReferences: string[] | undefined;
	let childBash: string | undefined;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (childBash && requests.length === 1) {
			res.end(
				`data: ${JSON.stringify({ id: "permission-read", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-permission", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: childBash, reason: "Read the inherited permission mode" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
			);
			return;
		}

		if (readReferences && requests.length === 1) {
			const tools = requests[0].tools as Array<{
				function?: { name?: string };
			}>;
			const reader = tools.find((tool) =>
				/^mcp__octocode__(localFetch|localGetFileContent)$/.test(tool.function?.name ?? ""),
			)?.function?.name;
			if (!reader) {
				res.end();
				return;
			}
			const queries = readReferences.map((file) =>
				reader.endsWith("localFetch")
					? { path: file, ranges: [{ startLine: 1, endLine: 10 }] }
					: { path: file, startLine: 1, endLine: 10, minify: "none" },
			);
			res.end(
				`data: ${JSON.stringify({ id: "reference-read", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-reference", type: "function", function: { name: reader, arguments: JSON.stringify({ queries }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
			);
			return;
		}

		res.end(
			`data: ${JSON.stringify({ id: `child-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "CHILD_COMPLETE" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"fixture-local": {
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
					apiKey: "fixture-key",
					api: "openai-completions",
					models: [
						{
							id: "fixture",
							name: "Fixture",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	for (const [key, value] of Object.entries({
		HOME: home,
		OCTOCODE_HOME: path.join(home, ".octocode"),
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		CODEX_HOME: path.join(home, ".codex"),
		OCTOCODE_MCP: "1",
		OCTOCODE_HOOKS: "0",
		OCTOCODE_HOOKS_COMPAT: "1",
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_PERMISSION: "full",
		OCTOCODE_SUBAGENT: "0",
		OCTOCODE_EXTRA_SKILLS: "0",
		OCTOCODE_SUBAGENT_LINGER_SECONDS: "0",
	}))
		vi.stubEnv(key, value);
	const modelOnly = path.join(root, "model-only", "SKILL.md");
	fs.mkdirSync(path.dirname(modelOnly));
	fs.writeFileSync(
		modelOnly,
		"---\nname: model-only\ndescription: Model-only accepted resource\nuser-invocable: false\n---\nMODEL_ONLY_BODY\n",
	);
	fs.writeFileSync(path.join(path.dirname(modelOnly), "reference.md"), "REFERENCE_model-only\n");
	const modelOnlyAlias = path.join(root, "model-only-alias");
	fs.symlinkSync(path.dirname(modelOnly), modelOnlyAlias);
	const modelOnlyReplacement = path.join(root, "model-only-replacement");
	fs.mkdirSync(modelOnlyReplacement);
	fs.writeFileSync(
		path.join(modelOnlyReplacement, "SKILL.md"),
		"---\nname: model-only\ndescription: Replaced resource\nuser-invocable: false\n---\nUNACCEPTED_MODEL_BODY\n",
	);
	fs.writeFileSync(path.join(modelOnlyReplacement, "reference.md"), "UNACCEPTED_MODEL_REFERENCE\n");
	const plugin = path.join(root, "plugin"),
		pluginSkill = path.join(plugin, "skills", "review", "SKILL.md");
	fs.mkdirSync(path.dirname(pluginSkill), { recursive: true });
	fs.writeFileSync(path.join(plugin, "plugin.json"), JSON.stringify({ name: "review-kit" }));

	const pluginHeader = "---\nname: review\ndescription: Qualified accepted resource\n---\nPLUGIN_QUALIFIED_BODY\n";
	const pluginPrefix = pluginHeader + "x".repeat(7999 - Buffer.byteLength(pluginHeader));
	fs.writeFileSync(pluginSkill, pluginPrefix + "🙂PLUGIN_TAIL_EXCLUDED");
	const makeSkill = (folder: string, name: string, body: string) => {
		const file = path.join(root, folder, "SKILL.md");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${folder} accepted fixture\n---\n${body}\n`);
		fs.writeFileSync(path.join(path.dirname(file), "reference.md"), `REFERENCE_${folder}\n`);
		return file;
	};
	const winner = makeSkill("winner", "collision", "WINNER_BODY"),
		loser = makeSkill("loser", "collision", "LOSER_BODY");
	const canonical = makeSkill("canonical", "aliased", "CANONICAL_BODY"),
		retarget = makeSkill("retarget", "aliased", "RETARGET_BODY"),
		alias = path.join(root, "alias");
	fs.symlinkSync(path.dirname(canonical), alias);
	const claudePlugin = path.join(root, "claude-plugin");
	fs.mkdirSync(path.join(claudePlugin, ".claude-plugin"), { recursive: true });
	fs.writeFileSync(path.join(claudePlugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "argument-kit" }));
	const claudeSkill = path.join(claudePlugin, "skills", "arguments", "SKILL.md");
	fs.mkdirSync(path.dirname(claudeSkill), { recursive: true });
	const claudeCanonical = path.join(claudePlugin, "accepted.md"),
		claudeReplacement = path.join(claudePlugin, "replacement.md");
	fs.writeFileSync(
		claudeCanonical,
		"---\nname: arguments\ndescription: Claude argument fixture\n---\nARGUMENT_VALUE=$0;ROOT=${CLAUDE_PLUGIN_ROOT}\n",
	);

	fs.writeFileSync(
		claudeReplacement,
		"---\nname: arguments\ndescription: Replaced Claude resource\n---\nUNACCEPTED_CLAUDE_BODY\n",
	);
	fs.symlinkSync(claudeCanonical, claudeSkill);

	const faux = createFauxCore({
		provider: "faux-parent",
		models: [{ id: "parent", contextWindow: 200000, maxTokens: 4096 }],
	});
	let commands: string[] = [];
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		plugins: [
			{ path: plugin, protocol: "codex" },
			{ path: claudePlugin, protocol: "claude" },
		],
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [path.join(modelOnlyAlias, "SKILL.md"), winner, loser, path.join(alias, "SKILL.md")],
		extensionFactories: [
			{
				name: "parent-fixture",
				factory: (pi) => {
					pi.registerProvider("faux-parent", {
						name: "Fixture parent",
						api: faux.api,
						baseUrl: "http://127.0.0.1:0",
						apiKey: "test",
						models: faux.models,
						streamSimple: faux.streamSimple,
					} as never);
					pi.on("session_start", () => {
						commands = pi.getCommands().map((c) => c.name);
					});
				},
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.create(cwd, path.join(root, "parent-sessions")),
	});
	await session.bindExtensions({
		mode: "json",
		shutdownHandler: () => undefined,
	} as never);
	await session.setModel(session.modelRuntime.getModel("faux-parent", "parent")!);
	let parentCatalog = "";
	const run = async (task: string, skills?: string[], expectedError = false, background = false) => {
		faux.setResponses([
			(context) => {
				parentCatalog = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage(
					[
						fauxToolCall("agent", {
							reason: "Delegate the inspection",
							type: "task",
							input: {
								goal: "Inspect inherited skills",
								task,
								model: "fixture-local/fixture",
								...(background ? { background: true } : {}),
								...(skills !== undefined ? { skills } : {}),
							},
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("PARENT_COMPLETE"),
			fauxAssistantMessage("PARENT_BACKGROUND_COMPLETE"),
		]);
		await session.prompt("Delegate the accepted skill fixture.");
		const result = session.messages.findLast((m) => m.role === "toolResult");
		expect(result?.role).toBe("toolResult");
		if (result?.role === "toolResult") {
			if (expectedError) expect(result.isError, JSON.stringify(result)).toBe(true);
			else expect(result.isError, JSON.stringify(result)).not.toBe(true);
		}
		return result;
	};

	const message = async (to: string, text: string) => {
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("agent", {
							reason: "Delegate the inspection",
							type: "message",
							input: { to, message: text, replyRequired: true },
						}),
					],
					{ stopReason: "toolUse" },
				),
			fauxAssistantMessage("PARENT_MESSAGE_COMPLETE"),
			fauxAssistantMessage("PARENT_REPORT_COMPLETE"),
		]);
		await session.prompt("Send the approved follow-up to the existing child.");
		const result = session.messages.findLast((m) => m.role === "toolResult");
		expect(result?.role).toBe("toolResult");
		if (result?.role === "toolResult") expect(result.isError, JSON.stringify(result)).not.toBe(true);
	};
	return {
		root,
		cwd,
		modelOnly,
		modelOnlyAlias,
		modelOnlyReplacement,
		claudeSkill,
		claudeCanonical,
		claudeReplacement,
		pluginSkill,
		pluginPrefix,
		winner,
		loser,
		canonical,
		retarget,
		alias,
		claudePlugin,
		requests,
		session,
		resourceLoader,
		run,
		message,
		childBash: (command: string) => {
			childBash = command;
		},
		readReferences: (files: string[]) => {
			readReferences = files;
		},
		commands: () => commands,
		parentCatalog: () => parentCatalog,
		close: async () => {
			await session.abort("shutdown");
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
it("inherits accepted model-only and qualified plugin resources through the actual parent agent tool", async () => {
	const f = await fixture();
	try {
		await f.run("Inspect the inherited catalog and use $review-kit:review. Return a short report.");
		expect(f.parentCatalog()).toContain("<name>model-only</name>");
		expect(f.parentCatalog()).toContain("<name>review-kit:review</name>");
		expect(f.commands()).not.toContain("model-only");
		expect(f.commands()).toContain("review-kit:review");
		expect(f.requests).toHaveLength(1);
		const child = JSON.stringify(f.requests[0]);
		expect(child).toContain("<name>model-only</name>");
		expect(child).toContain("<name>review-kit:review</name>");
		expect(child).toContain("PLUGIN_QUALIFIED_BODY");
		expect(child).not.toContain("MODEL_ONLY_BODY");
	} finally {
		await f.close();
	}
}, 30000);

it("declares the mcp tool to a real child, so it can restart its own servers", async () => {
	const f = await fixture();
	try {
		await f.run("Inspect the inherited catalog and return a short report.");
		const declared = (f.requests[0].tools as Array<{ function?: { name?: string } }>).map(
			(tool) => tool.function?.name,
		);
		expect(declared).toContain("mcp");
		expect(declared).toContain("tool_search");
		// The child adopted the parent's skills, so it can load one by name.
		expect(declared).toContain("skill");
		expect(JSON.stringify(f.requests[0].messages)).toContain("Use the skill tool with a skill's name to load it");
	} finally {
		await f.close();
	}
}, 30000);

it("preserves portable plugin UTF8 byte policy when the child explicitly selects a qualified skill", async () => {
	const f = await fixture();
	try {
		await f.run("Use $review-kit:review.");
		const child = JSON.stringify(f.requests[0]);
		expect(child).toContain(JSON.stringify(f.pluginPrefix).slice(1, -1));
		expect(child).not.toContain("PLUGIN_TAIL_EXCLUDED");
		expect(child).not.toContain("🙂");
	} finally {
		await f.close();
	}
}, 30000);

it("preserves Claude plugin argument and root substitution through inherited slash invocation", async () => {
	const f = await fixture();
	try {
		await f.run("/skill:argument-kit:arguments chosen-value");
		const child = JSON.stringify(f.requests[0]);
		expect(child).toContain("ARGUMENT_VALUE=chosen-value");
		expect(child).toContain(`ROOT=${fs.realpathSync(f.claudePlugin)}`);
		expect(child).not.toContain("ARGUMENT_VALUE=$0");
	} finally {
		await f.close();
	}
}, 30000);

it("keeps explicit collision candidates selectable by captured path in a child", async () => {
	const f = await fixture();
	try {
		await f.run(`Use [$collision](${f.loser}).`);
		const child = JSON.stringify(f.requests[0]);
		expect(child).toContain("LOSER_BODY");
		expect(child).not.toContain("WINNER_BODY");
	} finally {
		await f.close();
	}
}, 30000);

it("retains ambiguity instead of resurrecting a deduplicated winner for a plain child mention", async () => {
	const f = await fixture();
	try {
		await f.run("Use $collision.");
		const child = JSON.stringify(f.requests[0]);
		expect(child).not.toContain("LOSER_BODY");
		expect(child).not.toContain("WINNER_BODY");
	} finally {
		await f.close();
	}
}, 30000);

it("uses the parent's canonical skill identity after its discovery symlink changes", async () => {
	const f = await fixture();
	try {
		fs.unlinkSync(f.alias);
		fs.symlinkSync(path.dirname(f.retarget), f.alias);
		await f.run(`Use [$aliased](${path.join(f.alias, "SKILL.md")}).`);
		const child = JSON.stringify(f.requests[0]);
		expect(child).toContain("CANONICAL_BODY");
		expect(child).not.toContain("RETARGET_BODY");
	} finally {
		await f.close();
	}
}, 30000);

it.each([[["review-kit:review"]], [[]]])(
	"inherits only an explicit skill subset %j",
	async (skills) => {
		const f = await fixture();
		try {
			await f.run("Use $review-kit:review and $collision.", skills);
			const child = JSON.stringify(f.requests[0]);
			if (skills.length === 0) expect(child).not.toContain("<available_skills>");
			for (const name of ["model-only", "review-kit:review", "collision", "argument-kit:arguments", "aliased"])
				if (skills.includes(name)) expect(child).toContain(`<name>${name}</name>`);
				else expect(child).not.toContain(`<name>${name}</name>`);
			expect(child.includes("PLUGIN_QUALIFIED_BODY")).toBe(skills.includes("review-kit:review"));
		} finally {
			await f.close();
		}
	},
	30000,
);

it("keeps inherited explicit/model-only reference roots aligned with real child MCP access", async () => {
	const f = await fixture();
	try {
		const unrelated = path.join(f.root, "unrelated.txt");
		fs.writeFileSync(unrelated, "UNRELATED_SECRET");
		const escape = path.join(path.dirname(f.loser), "escape.md");
		fs.symlinkSync(unrelated, escape);
		f.readReferences([
			path.join(path.dirname(f.loser), "reference.md"),
			path.join(path.dirname(f.modelOnly), "reference.md"),
			unrelated,
			escape,
		]);
		await f.run(`Use [$collision](${f.loser}) and inspect the loaded reference documents.`);
		expect(f.requests).toHaveLength(2);
		const second = JSON.stringify(f.requests[1]);
		expect(second).toContain("LOSER_BODY");
		expect(second).toContain("REFERENCE_loser");
		expect(second).toContain("REFERENCE_model-only");
		expect(second).not.toContain("UNRELATED_SECRET");
	} finally {
		await f.close();
	}
}, 30000);

it.each(["model-only", "missing-workflow"])(
	"rejects noninvocable or absent explicit subset %s before launching a child",
	async (name) => {
		const f = await fixture();
		try {
			await f.run("Inspect the requested skill.", [name], true);
			expect(f.requests).toHaveLength(0);
		} finally {
			await f.close();
		}
	},
	30000,
);

it("resumes the actual named child with its captured inventory after the parent reloads a changed alias", async () => {
	const f = await fixture();
	vi.stubEnv("OCTOCODE_SUBAGENT_LINGER_SECONDS", "60");
	try {
		const result = await f.run("Inspect the accepted catalog without expanding workflows.", undefined, false, true);
		await vi.waitFor(() => expect(f.requests).toHaveLength(1));
		if (result?.role !== "toolResult") throw new Error("Missing child result");
		const id = (result.details as { id: string }).id;
		expect(id).toEqual(expect.any(String));
		await vi.waitFor(() =>
			expect(
				f.session.sessionManager
					.getEntries()
					.some((e) => e.type === "custom_message" && e.customType === "octocode-agent-result"),
			).toBe(true),
		);
		await f.session.waitForIdle();
		fs.unlinkSync(f.alias);
		fs.symlinkSync(path.dirname(f.retarget), f.alias);
		await f.resourceLoader.reload();
		await f.message(id, `Use [$aliased](${path.join(f.alias, "SKILL.md")}) and return a short follow-up.`);
		await vi.waitFor(() => expect(f.requests).toHaveLength(2));
		const second = JSON.stringify(f.requests[1]);
		expect(second).toContain("CANONICAL_BODY");
		expect(second).not.toContain("RETARGET_BODY");
		expect(second).toContain("<name>model-only</name>");
		expect(second).toContain("<name>review-kit:review</name>");
	} finally {
		await f.close();
	}
}, 30000);

it("keeps live parent permission narrowing when handing accepted resources to the actual child", async () => {
	const f = await fixture();
	try {
		await f.session.prompt("/permissions workspace");
		f.childBash('printf "CHILD_PERMISSION=%s\\n" "$OCTOCODE_PERMISSION"');
		await f.run("Use $review-kit:review and inspect your inherited permission mode.");
		expect(f.requests).toHaveLength(2);
		const second = JSON.stringify(f.requests[1]);
		expect(second).toContain("CHILD_PERMISSION=workspace");
		expect(second).toContain("PLUGIN_QUALIFIED_BODY");
		expect(second).not.toContain("CHILD_PERMISSION=full");
	} finally {
		await f.close();
	}
}, 30000);

it.each([true, false])(
	"handles malformed private snapshot at real CLI startup with child=%s",
	async (isChild) => {
		const f = await fixture();
		const file = path.join(f.root, "invalid-snapshot.json");
		fs.writeFileSync(file, JSON.stringify({ version: 99, resources: [], explicitSkills: [] }), { mode: 0o600 });
		const launch = getCliInvocation();
		const child = spawn(
			launch.command,
			[
				...launch.prefix,
				"--mode",
				"rpc",
				"--model",
				"fixture-local/fixture",
				"--session-dir",
				path.join(f.root, "direct-session"),
				"--no-extensions",
				"--no-skills",
				"--tools",
				"bash",
			],
			{
				cwd: f.cwd,
				env: {
					...process.env,
					OCTOCODE_SUBAGENT: isChild ? "1" : "0",
					OCTOCODE_SKILL_SNAPSHOT_FILE: file,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stderr = "",
			pending = "",
			settled = false,
			exited = false;
		let code: number | null = null;
		const exit = new Promise<void>((resolve) =>
			child.once("close", (value) => {
				code = value;
				exited = true;
				resolve();
			}),
		);
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop()!;
			for (const line of lines.filter(Boolean)) {
				const e = JSON.parse(line);
				if (e.type === "agent_settled") settled = true;
			}
		});
		try {
			child.stdin.write(
				JSON.stringify({
					type: "prompt",
					id: "prompt",
					message: "Validate startup snapshot boundary",
				}) + "\n",
			);
			const deadline = Date.now() + 15000;
			while (isChild ? !exited : !settled) {
				if (Date.now() > deadline || (!isChild && exited))
					throw new Error(`Startup fixture failed: code=${code} stderr=${stderr}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (isChild) {
				expect(code).not.toBe(0);
				expect(stderr).toContain("Invalid or oversized child skill resource snapshot");
				expect(f.requests).toHaveLength(0);
			} else {
				expect(f.requests).toHaveLength(1);
				expect(stderr).not.toMatch(/Invalid child skill snapshot/i);
			}
		} finally {
			if (!exited) {
				child.stdin.end();
				await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3000))]);
				if (!exited) {
					child.kill("SIGKILL");
					await exit;
				}
			}
			await f.close();
		}
	},
	30000,
);

it("pins a model-only accepted alias for the child catalog and actual MCP reference access", async () => {
	const f = await fixture();
	try {
		fs.unlinkSync(f.modelOnlyAlias);
		fs.symlinkSync(f.modelOnlyReplacement, f.modelOnlyAlias);
		f.readReferences([
			path.join(path.dirname(f.modelOnly), "reference.md"),
			path.join(f.modelOnlyAlias, "reference.md"),
		]);
		await f.run("Inspect the inherited model-only catalog and its companion references.");
		expect(f.requests).toHaveLength(2);
		const first = JSON.stringify(f.requests[0]),
			second = JSON.stringify(f.requests[1]);
		// The catalog names skills; the `skill` tool returns the directory when one is loaded.
		expect(first).toContain("<name>model-only</name>");
		expect(first).not.toContain("UNACCEPTED_MODEL_BODY");
		expect(second).toContain("REFERENCE_model-only");
		expect(second).not.toContain("UNACCEPTED_MODEL_REFERENCE");
	} finally {
		await f.close();
	}
}, 30000);

it("pins a Claude plugin skill alias before the child expands its inherited slash command", async () => {
	const f = await fixture();
	try {
		fs.unlinkSync(f.claudeSkill);
		fs.symlinkSync(f.claudeReplacement, f.claudeSkill);
		await f.run("/skill:argument-kit:arguments kept-value");
		const child = JSON.stringify(f.requests[0]);
		expect(child).toContain("ARGUMENT_VALUE=kept-value");
		expect(child).toContain(`ROOT=${fs.realpathSync(f.claudePlugin)}`);
		expect(child).not.toContain("UNACCEPTED_CLAUDE_BODY");
	} finally {
		await f.close();
	}
}, 30000);
