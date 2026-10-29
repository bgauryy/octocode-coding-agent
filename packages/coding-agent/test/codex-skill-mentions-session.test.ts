import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createReadTool } from "./fixtures/read-tool.ts";
import type { InlineExtension } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";

type Spec = {
	name: string;
	folder?: string;
	body?: string;
	metadata?: string;
	frontmatter?: string;
	symlink?: boolean;
	claude?: boolean;
};
async function fixture(specs: Spec[] = [{ name: "alpha" }, { name: "beta" }], extensions: InlineExtension[] = []) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-mentions-session-")),
		cwd = path.join(root, "project"),
		agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const files = specs.map((spec, index) => {
		const dir = spec.claude
			? path.join(cwd, ".claude", "skills", spec.name)
			: path.join(root, "skills", spec.folder ?? `${index}-${spec.name}`);
		fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
		const file = path.join(dir, "SKILL.md");
		fs.writeFileSync(
			file,
			`---\nname: ${spec.name}\ndescription: Catalog ${spec.name}\n${spec.frontmatter ?? ""}---\n${spec.body ?? `BODY_${spec.name}_${index}`}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "agents/openai.yaml"),
			spec.metadata ?? "policy:\n  allow_implicit_invocation: false\n",
		);
		if (spec.symlink) {
			const alias = path.join(root, "aliases", `${index}-${spec.name}`);
			fs.mkdirSync(path.dirname(alias), { recursive: true });
			fs.symlinkSync(dir, alias, "dir");
			return path.join(alias, "SKILL.md");
		}
		return file;
	});
	const template = path.join(root, "from-template.md");
	fs.writeFileSync(template, "Generated template mentions $beta");
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		nativeFeatures: false,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: files,
		additionalPromptTemplatePaths: [template],
		extensionFactories: extensions,
		settingsManager: SettingsManager.inMemory(),
	});
	await loader.reload();
	const harness = await createHarness({
		resourceLoader: loader,
		tools: [createReadTool(cwd)],
		settings: { retry: { enabled: false } },
	});
	await harness.session.bindExtensions({});
	return {
		root,
		cwd,
		files,
		loader,
		harness,
		cleanup: () => {
			harness.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const userTexts = (context: TranscriptContext) =>
	context.messages
		.filter((message) => message.role === "user")
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		);
async function request(f: Fixture, text: string, options?: Parameters<Fixture["harness"]["session"]["prompt"]>[1]) {
	let seen: TranscriptContext | undefined;
	f.harness.setResponses([
		(context) => {
			seen = context;
			return fauxAssistantMessage("done");
		},
	]);
	await f.harness.session.prompt(text, options);
	return {
		context: seen,
		texts: seen ? userTexts(seen) : [],
		text: seen ? userTexts(seen).join("\n") : "",
	};
}

it("preserves embedded original text and injects full raw skill documents once in discovery order", async () => {
	const f = await fixture();
	try {
		const prompt = "Review $beta, then $alpha; $beta again.";
		const result = await request(f, prompt);
		expect(result.texts).toContain(prompt);
		for (const file of f.files) expect(result.text).toContain(fs.readFileSync(file, "utf8").trim());
		expect(result.text.match(/BODY_alpha_0/g)).toHaveLength(1);
		expect(result.text.match(/BODY_beta_1/g)).toHaveLength(1);
		expect(result.text.indexOf("BODY_alpha_0")).toBeLessThan(result.text.indexOf("BODY_beta_1"));
	} finally {
		f.cleanup();
	}
});

it.each(["Use `$alpha`.", "```text\n$alpha\n```", "Use \\$alpha.", "Use [$alpha]().", "Use $alpha.suffix."])(
	"matches source raw-text mention syntax: %s",
	async (prompt) => {
		const f = await fixture();
		try {
			expect((await request(f, prompt)).text).toContain("BODY_alpha_0");
		} finally {
			f.cleanup();
		}
	},
);

it.each([
	"Use ${alpha}.",
	"Use $unknown.",
	"Use $alpha_extra.",
	"Use [$alpha](/undiscovered/SKILL.md).",
	"Use [$alpha](app://fixture).",
	"Use [$alpha](mcp://fixture).",
	"Use [$alpha](plugin://fixture).",
])("does not select unrelated or nonmatching mentions: %s", async (prompt) => {
	const f = await fixture();
	try {
		expect((await request(f, prompt)).text).not.toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it("uses a loaded path independent of its label and selects paths before plain names", async () => {
	const f = await fixture();
	try {
		const prompt = `Use $alpha and [$wrong-label](${f.files[1]}).`;
		const result = await request(f, prompt);
		expect(result.text).toContain("BODY_beta_1");
		expect(result.text).toContain("BODY_alpha_0");
		expect(result.text.indexOf("BODY_beta_1")).toBeLessThan(result.text.indexOf("BODY_alpha_0"));
	} finally {
		f.cleanup();
	}
});

it("retains duplicate-name path identities while refusing ambiguous plain-name selection", async () => {
	const f = await fixture([
		{ name: "duplicate", folder: "one", body: "FIRST_IDENTITY" },
		{ name: "duplicate", folder: "two", body: "SECOND_IDENTITY" },
	]);
	try {
		const plain = await request(f, "Use $duplicate.");
		expect(plain.text).not.toContain("FIRST_IDENTITY");
		expect(plain.text).not.toContain("SECOND_IDENTITY");
		const linked = await request(f, `Use [$duplicate](${f.files[1]}).`);
		expect(linked.text).toContain("SECOND_IDENTITY");
		expect(linked.text).not.toContain("FIRST_IDENTITY");
	} finally {
		f.cleanup();
	}
});

it("excludes common environment names even when a matching skill exists", async () => {
	const f = await fixture([{ name: "home" }]);
	try {
		expect((await request(f, "Use $home and $HOME.")).text).not.toContain("BODY_home_0");
	} finally {
		f.cleanup();
	}
});

it("does not recursively scan the selected skill body for other mentions", async () => {
	const f = await fixture([{ name: "alpha", body: "ALPHA_BODY references $beta" }, { name: "beta" }]);
	try {
		const result = await request(f, "Use $alpha.");
		expect(result.text).toContain("ALPHA_BODY references $beta");
		expect(result.text).not.toContain("BODY_beta_1");
	} finally {
		f.cleanup();
	}
});

it("honors generated-input expansion bypass", async () => {
	const f = await fixture();
	try {
		expect((await request(f, "Generated $alpha", { expandPromptTemplates: false })).text).not.toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it("keeps existing slash invocation from injecting the same skill twice", async () => {
	const f = await fixture();
	try {
		const result = await request(f, "/skill:alpha $alpha");
		expect(result.text.match(/BODY_alpha_0/g)).toHaveLength(1);
	} finally {
		f.cleanup();
	}
});

it("runs input transformation on original text before selecting the transformed mentions", async () => {
	const seen: string[] = [];
	const f = await fixture(undefined, [
		(api) => {
			api.on("input", (event) => {
				seen.push(event.text);
				return {
					action: "transform",
					text: "Transformed $beta",
					images: event.images,
				};
			});
		},
	]);
	try {
		const result = await request(f, "Original $alpha");
		expect(seen).toEqual(["Original $alpha"]);
		expect(result.texts).toContain("Transformed $beta");
		expect(result.text).toContain("BODY_beta_1");
		expect(result.text).not.toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it("does not read a skill or request a provider after an input handler consumes the prompt", async () => {
	const f = await fixture(undefined, [
		(api) => {
			api.on("input", () => ({ action: "handled" }));
		},
	]);
	const read = vi.spyOn(fs, "readFileSync");
	try {
		const result = await request(f, "Use $alpha");
		expect(result.context).toBeUndefined();
		expect(read.mock.calls.some((args) => String(args[0]) === f.files[0])).toBe(false);
	} finally {
		read.mockRestore();
		f.cleanup();
	}
});

it("preserves image attachments alongside explicit skill fragments", async () => {
	const f = await fixture();
	try {
		const result = await request(f, "Describe this with $alpha", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				},
			],
		});
		expect(result.text).toContain("BODY_alpha_0");

		expect(
			result.context?.messages.some(
				(message) =>
					message.role === "user" &&
					typeof message.content !== "string" &&
					message.content.some((part) => part.type === "image" && part.data.length > 0),
			),
		).toBe(true);
	} finally {
		f.cleanup();
	}
});

it("loads other selected skills when one selected document has disappeared", async () => {
	const f = await fixture();
	try {
		fs.unlinkSync(f.files[0]);
		const result = await request(f, "Use $alpha and $beta");
		expect(result.text).toContain("BODY_beta_1");
		expect(result.text).not.toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it("does not read an undiscovered file referenced by a skill-shaped link", async () => {
	const f = await fixture();
	const outside = path.join(f.root, "undiscovered.md");
	fs.writeFileSync(outside, "UNREGISTERED_BODY");
	const read = vi.spyOn(fs, "readFileSync");
	try {
		const result = await request(f, `Use [$alpha](${outside})`);
		expect(result.text).not.toContain("UNREGISTERED_BODY");
		expect(result.text).not.toContain("BODY_alpha_0");
		expect(read.mock.calls.some((args) => String(args[0]) === outside)).toBe(false);
	} finally {
		read.mockRestore();
		f.cleanup();
	}
});

it("keeps product-excluded skills unavailable by both name and path", async () => {
	const f = await fixture([{ name: "alpha", metadata: "policy:\n  products: [codex]\n" }]);
	try {
		const result = await request(f, `Use $alpha and [$alpha](${f.files[0]})`);
		expect(result.text).not.toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it("reads the selected canonical identity even if its discovery symlink is retargeted", async () => {
	const f = await fixture([{ name: "alpha", symlink: true }]);
	try {
		const evil = path.join(f.root, "retarget");
		fs.mkdirSync(evil);
		fs.writeFileSync(path.join(evil, "SKILL.md"), "RETARGET_BODY");
		const alias = path.dirname(f.files[0]);
		fs.unlinkSync(alias);
		fs.symlinkSync(evil, alias, "dir");
		const result = await request(f, `Use [$alpha](${f.files[0]})`);
		expect(result.text).toContain("BODY_alpha_0");
		expect(result.text).not.toContain("RETARGET_BODY");
	} finally {
		f.cleanup();
	}
});

it("does not scan prompt template output for newly generated skill mentions", async () => {
	const f = await fixture();
	try {
		const result = await request(f, "/from-template");
		expect(result.text).toContain("Generated template mentions $beta");
		expect(result.text).not.toContain("BODY_beta_1");
	} finally {
		f.cleanup();
	}
});

it.each(["steer", "followUp"] as const)(
	"expands explicitly selected skills through queued %s input",
	async (method) => {
		let begin!: () => void, release!: () => void;
		const began = new Promise<void>((resolve) => {
				begin = resolve;
			}),
			released = new Promise<void>((resolve) => {
				release = resolve;
			});
		const f = await fixture(undefined, [
			(api) => {
				api.registerTool({
					name: "wait",
					label: "wait",
					description: "Controlled fixture wait",
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
		]);
		const observed: TranscriptContext[] = [];
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], {
				stopReason: "toolUse",
			}),
			...Array.from({ length: 3 }, () => (context: TranscriptContext) => {
				observed.push(context);
				return fauxAssistantMessage("done");
			}),
		]);
		let running: Promise<void> | undefined;
		try {
			running = f.harness.session.prompt("Start fixture wait");
			await began;
			await f.harness.session[method]("Queued use of $alpha");
			release();
			await running;
			expect(observed.some((context) => userTexts(context).includes("Queued use of $alpha"))).toBe(true);
			const last = observed.at(-1);
			expect(
				last &&
					userTexts(last)
						.join("\n")
						.match(/BODY_alpha_0/g),
			).toHaveLength(1);
		} finally {
			release();
			await running;
			f.cleanup();
		}
	},
);

it("retains the native user-invocable restriction for name and path mentions", async () => {
	const f = await fixture([{ name: "alpha", frontmatter: "user-invocable: false\n" }]);
	try {
		const result = await request(f, `Use $alpha and [$alpha](${f.files[0]})`);
		expect(result.text).not.toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it.each(["disabled", "untrusted"])("cannot select a %s discovery resource by name or path", async (kind) => {
	const f = await fixture([]);
	const agentDir = path.join(f.root, "agent");
	let extra: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		const dir =
			kind === "disabled"
				? path.join(agentDir, "skills", "restricted")
				: path.join(f.root, "not-discovered", "restricted");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "SKILL.md");
		fs.writeFileSync(file, "---\nname: restricted\ndescription: Restricted fixture\n---\nRESTRICTED_RESOURCE_BODY");
		if (kind === "disabled")
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["!restricted"] }));
		else {
			fs.mkdirSync(path.join(f.cwd, ".octocode"), { recursive: true });
			fs.writeFileSync(path.join(f.cwd, ".octocode/settings.json"), JSON.stringify({ skills: [file] }));
		}
		const loader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir,
			nativeFeatures: false,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			settingsManager: SettingsManager.create(f.cwd, agentDir, {
				projectTrusted: false,
			}),
		});
		await loader.reload();
		expect(loader.getSkills().skills.some((skill) => skill.name === "restricted")).toBe(false);
		extra = await createHarness({
			resourceLoader: loader,
			tools: [createReadTool(f.cwd)],
			settings: { retry: { enabled: false } },
		});
		let sent = "";
		extra.setResponses([
			(context) => {
				sent = userTexts(context).join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await extra.session.prompt(`Use $restricted and [$restricted](${file})`);
		expect(sent).not.toContain("RESTRICTED_RESOURCE_BODY");
	} finally {
		extra?.cleanup();
		f.cleanup();
	}
});

it("keeps inferred Claude skills on their existing slash route", async () => {
	const f = await fixture([{ name: "alpha", claude: true }]);
	try {
		expect((await request(f, "Use $alpha")).text).not.toContain("BODY_alpha_0");
		expect((await request(f, "/skill:alpha")).text).toContain("BODY_alpha_0");
	} finally {
		f.cleanup();
	}
});

it.each(["portable", "legacy"])("uses qualified plugin mention names and %s prompt byte policy", async (format) => {
	const f = await fixture([]);
	let extra: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		const plugin = path.join(f.root, "plugin"),
			skillDir = path.join(plugin, "skills", "review");
		fs.mkdirSync(skillDir, { recursive: true });
		const manifest =
			format === "portable" ? path.join(plugin, "plugin.json") : path.join(plugin, ".codex-plugin/plugin.json");
		fs.mkdirSync(path.dirname(manifest), { recursive: true });
		fs.writeFileSync(manifest, JSON.stringify({ name: "review-kit" }));
		const header = "---\nname: review\ndescription: Plugin review fixture\n---\n";
		const prefix = header + "x".repeat(7999 - Buffer.byteLength(header));
		const full = prefix + "🙂PLUGIN_END";
		fs.writeFileSync(path.join(skillDir, "SKILL.md"), full);
		const loader = new DefaultResourceLoader({
			cwd: f.cwd,
			agentDir: path.join(f.root, "agent"),
			nativeFeatures: false,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory({
				plugins: [{ path: plugin, protocol: "codex" }],
			}),
		});
		await loader.reload();
		extra = await createHarness({
			resourceLoader: loader,
			tools: [createReadTool(f.cwd)],
			settings: { retry: { enabled: false } },
		});
		let sent: string[] = [];
		extra.setResponses([
			(context) => {
				sent = userTexts(context);
				return fauxAssistantMessage("done");
			},
		]);
		await extra.session.prompt("Use $review-kit:review");
		expect(sent).toContain("Use $review-kit:review");
		const block = sent.find((text) => text.startsWith("<skill>"));
		expect(block).toBeDefined();
		expect(block).toContain("<name>review-kit:review</name>");
		const content = block!.slice(block!.indexOf("</path>\n") + 8, -"\n</skill>".length);
		expect(content).toBe(format === "portable" ? prefix : full);
		expect(content).not.toContain("�");
	} finally {
		extra?.cleanup();
		f.cleanup();
	}
});

it("skips invalid UTF-8 selected content while injecting the remaining valid skill", async () => {
	const f = await fixture();
	try {
		fs.writeFileSync(f.files[0], Buffer.from([0xc3, 0x28]));
		const result = await request(f, "Use $alpha and $beta");
		expect(result.text).toContain("BODY_beta_1");
		expect(result.text).not.toContain("�");
		expect(result.text).not.toContain("<name>alpha</name>");
	} finally {
		f.cleanup();
	}
});
