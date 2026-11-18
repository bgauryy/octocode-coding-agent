// The session runs without the native feature set, which would install the MCP host ports its prompt reads.
import "./mcp-host.ts";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadTool } from "./fixtures/read-tool.ts";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { createHarness } from "./suite/harness.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";
import { testFeatures } from "./helpers/features.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Capture = {
	hook_event_name: string;
	prompt?: string;
	turn_id?: string;
	profile: string;
};
async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-input-"));
	const cwd = path.join(root, "project"),
		agentDir = path.join(root, "agent"),
		capture = path.join(root, "capture.jsonl");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const skill = path.join(root, "skill", "SKILL.md");
	fs.mkdirSync(path.dirname(skill));
	fs.writeFileSync(skill, "---\nname: alpha\ndescription: Alpha fixture\n---\nSKILL_BODY_EVIDENCE\n");
	const template = path.join(root, "expanded.md");
	fs.writeFileSync(template, "TEMPLATE_BODY_EVIDENCE $1");
	const script = path.join(root, "hook.cjs");
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const input=JSON.parse(data);const profile=process.argv[2];fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({...input,profile})+'\\n');if(profile==='codex' && input.hook_event_name==='UserPromptSubmit' && input.prompt.startsWith('HOLD selected')){while(!fs.existsSync(${JSON.stringify(path.join(root, "release-hook"))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}console.log(JSON.stringify(profile==='codex' && input.hook_event_name==='UserPromptSubmit' && input.prompt.includes('BLOCK')?{decision:'block',reason:'fixture rejection',hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'BLOCKED_CONTEXT_EVIDENCE'}}:profile==='codex' && input.hook_event_name==='UserPromptSubmit' && input.prompt.includes('CONTEXT')?{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'ACCEPTED_CONTEXT_EVIDENCE'}}:profile==='codex' && input.hook_event_name==='Stop' && input.last_assistant_message==='CONTINUE_STOP' && !input.stop_hook_active?{decision:'block',reason:'Continue fixture'}:{}));});`,
	);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, ".octocode"));
	for (const profile of ["codex", "claude"]) {
		const dir = path.join(root, `.${profile}`);
		fs.mkdirSync(dir);
		const command = `${quote(process.execPath)} ${quote(script)} ${profile}`;
		const events =
			profile === "codex" ? ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] : ["UserPromptSubmit"];
		fs.writeFileSync(
			path.join(dir, profile === "claude" ? "settings.json" : "hooks.json"),
			JSON.stringify({
				hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command }] }]])),
			}),
		);
	}
	let begin!: () => void, release!: () => void;
	const began = new Promise<void>((resolve) => {
			begin = resolve;
		}),
		released = new Promise<void>((resolve) => {
			release = resolve;
		});
	const beforePrompts: string[] = [];
	const settledIds: Array<string | undefined> = [];
	let currentId = (): string | undefined => undefined;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		disabledFeatures: ["mcp"],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [skill],
		additionalPromptTemplatePaths: [template],
		settingsManager: SettingsManager.inMemory({ ...HOOK_SETTINGS }),
		features: testFeatures([
			(api) => {
				api.bus.on("session_start", (_event, ctx) => {
					currentId = () => ctx.getTurnId();
				});
				api.bus.on("agent_settled", (_event, ctx) => {
					settledIds.push(ctx.getTurnId());
				});
				api.bus.on("input", (event) =>
					event.text === "TRANSFORM" ? { action: "transform", text: "Use $alpha" } : { action: "continue" },
				);
				api.bus.on("before_agent_start", (event) => {
					if (event.messageType === "user") beforePrompts.push(event.prompt);
				});
				const hooks = registerHooks(api, { env: {}, home: root });
				api.bus.on("tool_call", (event, ctx) => hooks.preToolUse(event, ctx));
				api.tools.register({
					name: "wait",
					label: "wait",
					description: "Controlled wait",
					parameters: Type.Object({}),
					execute: async () => {
						begin();
						await released;
						return {
							content: [{ type: "text", text: "released" }],
							details: {},
						};
					},
				});
			},
		]),
	});
	await loader.reload();
	const harness = await createHarness({
		resourceLoader: loader,
		tools: [createReadTool(cwd)],
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
	});
	await harness.session.bindFeatures({});
	const records = (): Capture[] =>
		fs.existsSync(capture)
			? fs
					.readFileSync(capture, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	return {
		root,
		beforePrompts,
		settledIds,
		currentId: () => currentId(),
		skill,
		harness,
		records,
		began,
		release,
		releaseHook: () => fs.writeFileSync(path.join(root, "release-hook"), "ready"),
		cleanup: () => {
			harness.cleanup();
			vi.unstubAllEnvs();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
const submits = (f: Awaited<ReturnType<typeof fixture>>, profile = "codex") =>
	f.records().filter((record) => record.profile === profile && record.hook_event_name === "UserPromptSubmit");
const users = (context: TranscriptContext) =>
	context.messages
		.filter((message) => message.role === "user")
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		);

it.each(["steer", "followUp"] as const)(
	"defers Codex %s hooks until consumption while preserving Claude admission",
	async (method) => {
		const f = await fixture();
		let running: Promise<void> | undefined;
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], {
				stopReason: "toolUse",
			}),
			...Array.from({ length: 3 }, () => fauxAssistantMessage("done")),
		]);
		try {
			running = f.harness.session.prompt("initial");
			await f.began;
			await f.harness.session[method]("queued $alpha");
			expect(submits(f, "claude").map((x) => x.prompt)).toContain("queued $alpha");
			expect(submits(f).map((x) => x.prompt)).toEqual(["initial"]);
			f.release();
			await running;
			expect(submits(f).map((x) => x.prompt)).toEqual(["initial", "queued $alpha"]);
			const [initial, queued] = submits(f);
			expect(initial.turn_id).toEqual(expect.any(String));
			expect(initial.turn_id).not.toBe("");
			if (method === "steer") expect(queued.turn_id).toBe(initial.turn_id);
			else expect(queued.turn_id).not.toBe(initial.turn_id);
			expect(f.harness.session.pendingMessageCount).toBe(0);
		} finally {
			f.release();
			await running;
			f.cleanup();
		}
	},
);

it("keeps one logical ID through tools and Stop", async () => {
	const f = await fixture();
	f.release();
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	try {
		await f.harness.session.prompt("initial");
		const records = f.records().filter((x) => x.profile === "codex");
		expect(records.map((x) => x.hook_event_name)).toEqual(
			expect.arrayContaining(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
		);
		expect(records.every((x) => typeof x.turn_id === "string" && x.turn_id.length > 0)).toBe(true);
		expect(new Set(records.map((x) => x.turn_id)).size).toBe(1);
	} finally {
		f.cleanup();
	}
});

it.each(["all", "one-at-a-time"] as const)("allocates consumed follow-up IDs per %s batch", async (mode) => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	f.harness.session.agent.followUpMode = mode;
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], {
			stopReason: "toolUse",
		}),
		...Array.from({ length: 4 }, () => fauxAssistantMessage("done")),
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("queued-one");
		await f.harness.session.followUp("queued-two");
		f.release();
		await running;
		const records = submits(f);
		expect(records.map((x) => x.prompt)).toEqual(["initial", "queued-one", "queued-two"]);
		expect(records.every((x) => typeof x.turn_id === "string" && x.turn_id.length > 0)).toBe(true);
		expect(records[1].turn_id).not.toBe(records[0].turn_id);
		if (mode === "all") expect(records[2].turn_id).toBe(records[1].turn_id);
		else expect(records[2].turn_id).not.toBe(records[1].turn_id);
	} finally {
		f.release();
		await running;
		f.cleanup();
	}
});

it("blocks initial input before reading selected skills and retains hook context without Stop", async () => {
	const f = await fixture();
	let calls = 0;
	f.harness.setResponses([
		() => {
			calls++;
			return fauxAssistantMessage("unexpected");
		},
	]);
	const read = vi.spyOn(fs, "readFileSync");
	syncBuiltinESMExports();
	try {
		await f.harness.session.prompt("BLOCK $alpha");
		expect(calls).toBe(0);
		expect(read.mock.calls.some(([file]) => [f.skill, fs.realpathSync(f.skill)].includes(String(file)))).toBe(false);
		expect(JSON.stringify(f.harness.session.messages)).toContain("BLOCKED_CONTEXT_EVIDENCE");
		expect(f.records().filter((x) => x.profile === "codex" && x.hook_event_name === "Stop")).toHaveLength(0);
		expect(submits(f)[0].turn_id).toEqual(expect.any(String));
	} finally {
		read.mockRestore();
		syncBuiltinESMExports();
		f.cleanup();
	}
});

it.each([false, true])("filters consumed blocked follow-up items (all blocked: %s)", async (allBlocked) => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	f.harness.session.agent.followUpMode = "all";
	const observed: TranscriptContext[] = [];
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], {
			stopReason: "toolUse",
		}),
		...Array.from({ length: 4 }, () => (context: TranscriptContext) => {
			observed.push(context);
			return fauxAssistantMessage("done");
		}),
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("BLOCK first");
		await f.harness.session.followUp(allBlocked ? "BLOCK second" : "accepted second");
		expect(f.harness.session.pendingMessageCount).toBe(2);
		f.release();
		await running;
		expect(observed).toHaveLength(allBlocked ? 1 : 2);
		const text = users(observed.at(-1)!);
		expect(text).not.toContain("BLOCK first");
		expect(text).not.toContain("BLOCK second");
		if (!allBlocked) expect(text).toContain("accepted second");
		expect(JSON.stringify(f.harness.session.messages)).toContain("BLOCKED_CONTEXT_EVIDENCE");
		expect(f.harness.session.pendingMessageCount).toBe(0);
		const queued = submits(f).filter((x) => x.prompt !== "initial");
		expect(queued).toHaveLength(2);
		expect(queued[0].turn_id).toBe(queued[1].turn_id);
		if (allBlocked)
			expect(
				f
					.records()
					.filter(
						(record) =>
							record.profile === "codex" && record.hook_event_name === "Stop" && record.turn_id === queued[0].turn_id,
					),
			).toHaveLength(0);
		expect(f.currentId()).toBeUndefined();
	} finally {
		f.release();
		await running;
		f.cleanup();
	}
});

it("does not consume cleared queued input or read its skill", async () => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const read = vi.spyOn(fs, "readFileSync");
	syncBuiltinESMExports();
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("cleared $alpha");
		f.harness.session.clearQueue();
		f.release();
		await running;
		expect(submits(f).map((x) => x.prompt)).toEqual(["initial"]);
		expect(read.mock.calls.some(([file]) => [f.skill, fs.realpathSync(f.skill)].includes(String(file)))).toBe(false);
		expect(f.harness.session.pendingMessageCount).toBe(0);
	} finally {
		read.mockRestore();
		syncBuiltinESMExports();
		f.release();
		await running;
		f.cleanup();
	}
});

it.each(["Use $alpha", "/expanded argument"])(
	"hooks receive raw processed request before expansion: %s",
	async (prompt) => {
		const f = await fixture();
		let observed: TranscriptContext | undefined;
		f.harness.setResponses([
			(context) => {
				observed = context;
				return fauxAssistantMessage("done");
			},
		]);
		try {
			await f.harness.session.prompt(prompt);
			expect(submits(f).map((x) => x.prompt)).toEqual([prompt]);
			expect(users(observed!).join("\n")).toContain(
				prompt.startsWith("/") ? "TEMPLATE_BODY_EVIDENCE" : "SKILL_BODY_EVIDENCE",
			);
		} finally {
			f.cleanup();
		}
	},
);

it("gates user input even when expansion is disabled", async () => {
	const f = await fixture();
	let calls = 0;
	f.harness.setResponses([
		() => {
			calls++;
			return fauxAssistantMessage("unexpected");
		},
	]);
	try {
		await f.harness.session.prompt("BLOCK $alpha", {
			expandPromptTemplates: false,
		});
		expect(submits(f).map((x) => x.prompt)).toEqual(["BLOCK $alpha"]);
		expect(calls).toBe(0);
	} finally {
		f.cleanup();
	}
});

it("does not recursively submit accepted hook context", async () => {
	const f = await fixture();
	let observed: TranscriptContext | undefined;
	f.harness.setResponses([
		(context) => {
			observed = context;
			return fauxAssistantMessage("done");
		},
	]);
	try {
		await f.harness.session.prompt("CONTEXT request");
		expect(submits(f).map((x) => x.prompt)).toEqual(["CONTEXT request"]);
		expect(JSON.stringify(observed!.messages)).toContain("ACCEPTED_CONTEXT_EVIDENCE");
	} finally {
		f.cleanup();
	}
});

it("does not run Stop for a fully blocked steering batch", async () => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	let additionalRequests = 0;
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		() => {
			additionalRequests++;
			return fauxAssistantMessage("unexpected");
		},
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.steer("BLOCK steering");
		f.release();
		await running;
		expect(additionalRequests).toBe(0);
		expect(f.records().filter((x) => x.profile === "codex" && x.hook_event_name === "Stop")).toHaveLength(0);
		expect(f.harness.session.pendingMessageCount).toBe(0);
		expect(JSON.stringify(f.harness.session.messages)).toContain("BLOCKED_CONTEXT_EVIDENCE");
	} finally {
		f.release();
		await running;
		f.cleanup();
	}
});

it("does not reuse the previous assistant for Stop after a blocked initial prompt", async () => {
	const f = await fixture();
	f.harness.setResponses([fauxAssistantMessage("prior response")]);
	try {
		await f.harness.session.prompt("prior");
		const stops = f.records().filter((x) => x.profile === "codex" && x.hook_event_name === "Stop").length;
		await f.harness.session.prompt("BLOCK next");
		expect(f.records().filter((x) => x.profile === "codex" && x.hook_event_name === "Stop")).toHaveLength(stops);
		const ids = submits(f).map((x) => x.turn_id);
		expect(ids[1]).toEqual(expect.any(String));
		expect(ids[1]).not.toBe(ids[0]);
	} finally {
		f.cleanup();
	}
});

it("retains logical turn ID and one submission across a transient provider retry", async () => {
	const f = await fixture();
	f.harness.settingsManager.applyOverrides({
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
	});
	f.release();
	f.harness.setResponses([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error",
		}),
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	try {
		await f.harness.session.prompt("retry fixture");
		expect(submits(f)).toHaveLength(1);
		const records = f.records().filter((x) => x.profile === "codex");
		expect(records.map((x) => x.hook_event_name)).toContain("Stop");
		expect(records.every((x) => typeof x.turn_id === "string" && x.turn_id.length > 0)).toBe(true);
		expect(new Set(records.map((x) => x.turn_id)).size).toBe(1);
	} finally {
		f.cleanup();
	}
});

it("retains the logical ID through a blocking Stop continuation", async () => {
	const f = await fixture();
	f.harness.setResponses([fauxAssistantMessage("CONTINUE_STOP"), fauxAssistantMessage("done")]);
	try {
		await f.harness.session.prompt("continue fixture");
		expect(submits(f)).toHaveLength(1);
		const records = f.records().filter((x) => x.profile === "codex");
		expect(records.filter((x) => x.hook_event_name === "Stop")).toHaveLength(2);
		expect(records.every((x) => typeof x.turn_id === "string" && x.turn_id.length > 0)).toBe(true);
		expect(new Set(records.map((x) => x.turn_id)).size).toBe(1);
	} finally {
		f.cleanup();
	}
});

it("reads a selected skill only after the consumed submit hook accepts it", async () => {
	const f = await fixture();
	const observed: Capture[][] = [];
	const original = fs.readFileSync;
	const read = vi.spyOn(fs, "readFileSync").mockImplementation(((
		file: Parameters<typeof fs.readFileSync>[0],
		...args: unknown[]
	) => {
		if ([f.skill, fs.realpathSync(f.skill)].includes(String(file))) observed.push(submits(f));
		return Reflect.apply(original, fs, [file, ...args]);
	}) as typeof fs.readFileSync);
	syncBuiltinESMExports();
	f.harness.setResponses([fauxAssistantMessage("done")]);
	try {
		await f.harness.session.prompt("Use $alpha");
		expect(observed.length).toBeGreaterThan(0);
		expect(observed.every((records) => records.length === 1 && records[0].prompt === "Use $alpha")).toBe(true);
	} finally {
		read.mockRestore();
		syncBuiltinESMExports();
		f.cleanup();
	}
});

it.each(["/expanded argument", "/skill:alpha argument"])(
	"preserves expanded before_agent_start for native request %s",
	async (prompt) => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("done")]);
		try {
			await f.harness.session.prompt(prompt);
			expect(f.beforePrompts).toHaveLength(1);
			expect(f.beforePrompts[0]).toContain(
				prompt.startsWith("/skill:") ? "SKILL_BODY_EVIDENCE" : "TEMPLATE_BODY_EVIDENCE",
			);
			expect(submits(f).map((x) => x.prompt)).toEqual([prompt]);
		} finally {
			f.cleanup();
		}
	},
);

it("gates the transformed user request before skill expansion", async () => {
	const f = await fixture();
	let observed: TranscriptContext | undefined;
	f.harness.setResponses([
		(context) => {
			observed = context;
			return fauxAssistantMessage("done");
		},
	]);
	try {
		await f.harness.session.prompt("TRANSFORM");
		expect(submits(f).map((x) => x.prompt)).toEqual(["Use $alpha"]);
		expect(users(observed!)).toContain("Use $alpha");
		expect(users(observed!).join("\n")).toContain("SKILL_BODY_EVIDENCE");
	} finally {
		f.cleanup();
	}
});

it("retains a blocked logical ID through settlement and clears it after return", async () => {
	const f = await fixture();
	try {
		await f.harness.session.prompt("BLOCK initial");
		const id = submits(f)[0].turn_id;
		expect(id).toEqual(expect.any(String));
		expect(f.settledIds).toEqual([id]);
		expect(f.currentId()).toBeUndefined();
	} finally {
		f.cleanup();
	}
});

it("places accepted user content before its hook additional context in the provider request", async () => {
	const f = await fixture();
	let observed: TranscriptContext | undefined;
	f.harness.setResponses([
		(context) => {
			observed = context;
			return fauxAssistantMessage("done");
		},
	]);
	try {
		await f.harness.session.prompt("CONTEXT ordered request");
		const messages = observed!.messages;
		const requestIndex = messages.findIndex(
			(message) =>
				message.role === "user" &&
				(typeof message.content === "string"
					? message.content === "CONTEXT ordered request"
					: message.content.some((part) => part.type === "text" && part.text === "CONTEXT ordered request")),
		);
		const contextIndex = messages.findIndex((message) => JSON.stringify(message).includes("ACCEPTED_CONTEXT_EVIDENCE"));
		expect(requestIndex).toBeGreaterThanOrEqual(0);
		expect(contextIndex).toBeGreaterThan(requestIndex);
		expect(submits(f)).toHaveLength(1);
	} finally {
		f.cleanup();
	}
});

it("allocates follow-up identity before next-turn preparation and before consumed hook dispatch", async () => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	const prepared: Array<{
		id: string | undefined;
		prompts: Array<string | undefined>;
	}> = [];
	const original = f.harness.session.agent.prepareNextTurnWithContext;
	expect(original).toBeTypeOf("function");
	f.harness.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
		prepared.push({
			id: f.currentId(),
			prompts: submits(f).map((record) => record.prompt),
		});
		return original!(turn, signal);
	};
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("initial response"),
		fauxAssistantMessage("followup response"),
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("followup");
		f.release();
		await running;
		const records = submits(f);
		expect(records.map((record) => record.prompt)).toEqual(["initial", "followup"]);
		expect(records[1].turn_id).not.toBe(records[0].turn_id);
		expect(prepared).toContainEqual({
			id: records[1].turn_id,
			prompts: ["initial"],
		});
	} finally {
		f.release();
		await running;
		f.harness.session.agent.prepareNextTurnWithContext = original;
		f.cleanup();
	}
});

it("retains an accepted empty text item in a mixed blocked follow-up batch", async () => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	f.harness.session.agent.followUpMode = "all";
	const observed: TranscriptContext[] = [];
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 2 }, () => (context: TranscriptContext) => {
			observed.push(context);
			return fauxAssistantMessage("done");
		}),
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("BLOCK first");
		await f.harness.session.followUp("");
		f.release();
		await running;
		expect(observed).toHaveLength(2);
		expect(users(observed[1])).toContain("");
		expect(users(observed[1])).not.toContain("BLOCK first");
		expect(submits(f).map((record) => record.prompt)).toEqual(["initial", "BLOCK first", ""]);
		const records = submits(f);
		expect(records[1].turn_id).toBe(records[2].turn_id);
		expect(f.harness.session.pendingMessageCount).toBe(0);
	} finally {
		f.release();
		await running;
		f.cleanup();
	}
});

it("still gates every selected item when clearQueue runs during its first hook", async () => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	f.harness.session.agent.followUpMode = "all";
	const observed: TranscriptContext[] = [];
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 2 }, () => (context: TranscriptContext) => {
			observed.push(context);
			return fauxAssistantMessage("done");
		}),
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("HOLD selected");
		await f.harness.session.followUp("BLOCK second selected");
		f.release();
		const deadline = Date.now() + 5000;
		while (!submits(f).some((record) => record.prompt === "HOLD selected") && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(submits(f).map((record) => record.prompt)).toEqual(["initial", "HOLD selected"]);
		f.harness.session.clearQueue();
		f.releaseHook();
		await running;
		expect(submits(f).map((record) => record.prompt)).toEqual(["initial", "HOLD selected", "BLOCK second selected"]);
		expect(observed).toHaveLength(2);
		expect(users(observed[1])).toContain("HOLD selected");
		expect(users(observed[1])).not.toContain("BLOCK second selected");
		expect(f.harness.session.pendingMessageCount).toBe(0);
	} finally {
		f.releaseHook();
		f.release();
		await running;
		f.cleanup();
	}
});

it("commits accepted batch items before a later hook waits and preserves them when that hook is cancelled", async () => {
	const f = await fixture();
	let running: Promise<void> | undefined;
	f.harness.session.agent.followUpMode = "all";
	const observed: TranscriptContext[] = [];
	const read = vi.spyOn(fs, "readFileSync");
	syncBuiltinESMExports();
	f.harness.setResponses([
		fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 2 }, () => (context: TranscriptContext) => {
			observed.push(context);
			return fauxAssistantMessage("done");
		}),
	]);
	try {
		running = f.harness.session.prompt("initial");
		await f.began;
		await f.harness.session.followUp("CONTEXT first accepted");
		await f.harness.session.followUp("HOLD selected $alpha");
		await f.harness.session.followUp("third unconsumed $alpha");
		f.release();
		const deadline = Date.now() + 5000;
		while (!submits(f).some((record) => record.prompt === "HOLD selected $alpha") && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(submits(f).map((record) => record.prompt)).toEqual([
			"initial",
			"CONTEXT first accepted",
			"HOLD selected $alpha",
		]);
		const during = JSON.stringify(f.harness.session.messages);
		expect(during).toContain("CONTEXT first accepted");
		expect(during).toContain("ACCEPTED_CONTEXT_EVIDENCE");
		const recordedDuring = JSON.stringify(f.harness.sessionManager.getEntries());
		expect(recordedDuring).toContain("CONTEXT first accepted");
		expect(recordedDuring).toContain("ACCEPTED_CONTEXT_EVIDENCE");
		await f.harness.session.abort();
		await running;
		const after = JSON.stringify(f.harness.session.messages);
		expect(after).toContain("CONTEXT first accepted");
		expect(after).toContain("ACCEPTED_CONTEXT_EVIDENCE");
		expect(after).not.toContain("HOLD selected $alpha");
		expect(after).not.toContain("third unconsumed $alpha");
		expect(f.harness.session.pendingMessageCount).toBe(0);
		expect(submits(f).map((record) => record.prompt)).toEqual([
			"initial",
			"CONTEXT first accepted",
			"HOLD selected $alpha",
		]);
		expect(after).not.toContain("SKILL_BODY_EVIDENCE");
		const recordedAfter = JSON.stringify(f.harness.sessionManager.getEntries());
		expect(recordedAfter).toContain("CONTEXT first accepted");
		expect(recordedAfter).toContain("ACCEPTED_CONTEXT_EVIDENCE");
		expect(recordedAfter).not.toContain("HOLD selected $alpha");
		expect(read.mock.calls.some(([file]) => [f.skill, fs.realpathSync(f.skill)].includes(String(file)))).toBe(false);
		expect(observed).toHaveLength(1);
	} finally {
		await f.harness.session.abort();
		f.releaseHook();
		f.release();
		await running;
		read.mockRestore();
		syncBuiltinESMExports();
		f.cleanup();
	}
});
