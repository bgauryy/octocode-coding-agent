import fs from "node:fs";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

const NAME = "policy-fixture";
const DESCRIPTION = "Unique policy fixture catalog description";
const BODY = "Unique policy fixture explicit instruction body";
async function fixture(
	metadata?: string,
	options: {
		claude?: boolean;
		nativeDisabled?: boolean;
		plugin?: boolean;
	} = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-policy-session-"));
	const cwd = path.join(root, "project"),
		agentDir = path.join(root, "agent");
	const skillDir = options.plugin
		? path.join(root, "plugin", "skills", NAME)
		: options.claude
			? path.join(cwd, ".claude", "skills", NAME)
			: path.join(root, "portable", NAME);
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(skillDir, "agents"), { recursive: true });
	const file = path.join(skillDir, "SKILL.md");
	fs.writeFileSync(
		file,
		`---\nname: ${NAME}\ndescription: ${DESCRIPTION}\n${options.nativeDisabled ? "disable-model-invocation: true\n" : ""}---\n${BODY}\n`,
	);
	if (metadata !== undefined) fs.writeFileSync(path.join(skillDir, "agents/openai.yaml"), metadata);
	if (options.plugin) {
		fs.mkdirSync(path.join(root, "plugin/.codex-plugin"), { recursive: true });
		fs.writeFileSync(path.join(root, "plugin/.codex-plugin/plugin.json"), JSON.stringify({ name: "policy-kit" }));
	}
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		nativeFeatures: false,
		disabledFeatures: ["mcp", "llama.cpp"],
		noSkills: !options.plugin,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: options.plugin ? [] : [file],
		settingsManager: SettingsManager.inMemory(
			options.plugin ? { plugins: [{ path: path.join(root, "plugin"), protocol: "codex" }] } : {},
		),
	});
	await loader.reload();
	const harness = await createHarness({
		resourceLoader: loader,
		// A tool the catalog can name as the skill reader: a plain `read` tool no longer lists skills.
		tools: [createBashTool(cwd)],
		settings: { retry: { enabled: false } },
	});
	return {
		root,
		loader,
		harness,
		skillDir,
		cleanup: () => {
			harness.cleanup();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(f: Fixture, prompt: string) {
	let system = "",
		messages = "";
	f.harness.setResponses([
		(context) => {
			system = getCurrentSystemPrompt(context.messages);
			messages = JSON.stringify(context.messages);
			return fauxAssistantMessage("done");
		},
	]);
	const start = f.harness.session.messages.length;
	await f.harness.session.prompt(prompt);
	const user = f.harness.session.messages.slice(start).find((message) => message.role === "user");
	return { system, messages, user: user ? getMessageText(user) : "" };
}

it("hides implicit Codex sidecar skills from the actual provider catalog but keeps explicit slash invocation", async () => {
	const f = await fixture("policy:\n  allow_implicit_invocation: false\n");
	try {
		expect(f.loader.getSkills().skills.some((skill) => skill.name === NAME)).toBe(true);
		const implicit = await request(f, "Explain the project.");
		expect(implicit.system).not.toContain(DESCRIPTION);
		expect(implicit.messages).not.toContain(BODY);
		const explicit = await request(f, `/skill:${NAME}`);
		expect(explicit.system).not.toContain(DESCRIPTION);
		expect(explicit.user).toContain(BODY);
	} finally {
		f.cleanup();
	}
});

it.each([
	undefined,
	"policy: {}\n",
	"policy: null\n",
	"policy:\n  allow_implicit_invocation: true\n",
	"policy:\n  allow_implicit_invocation: null\n",
])("defaults or enables implicit discovery with metadata %j", async (metadata) => {
	const f = await fixture(metadata);
	try {
		expect((await request(f, "Explain the project.")).system).toContain(DESCRIPTION);
	} finally {
		f.cleanup();
	}
});

it.each([
	"policy: [broken\n",
	'policy:\n  allow_implicit_invocation: "false"\n',
	"policy:\n  allow_implicit_invocation: false\ninterface: []\n",
	"policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: invalid\n",
	"policy:\n  allow_implicit_invocation: false\n  products: [not-a-product]\n",
])("discards invalid optional metadata while retaining the skill: %j", async (metadata) => {
	const f = await fixture(metadata);
	try {
		expect(f.loader.getSkills().skills.some((skill) => skill.name === NAME)).toBe(true);
		expect(f.loader.getSkills().diagnostics.some((item) => JSON.stringify(item).includes("openai.yaml"))).toBe(true);
		expect((await request(f, "Explain the project.")).system).toContain(DESCRIPTION);
		expect((await request(f, `/skill:${NAME}`)).user).toContain(BODY);
	} finally {
		f.cleanup();
	}
});

it("accepts serde-compatible scalar interface values without discarding the false policy", async () => {
	const f = await fixture(
		"interface:\n  display_name: 1\n  icon_small: true\npolicy:\n  allow_implicit_invocation: false\n",
	);
	try {
		expect((await request(f, "Explain the project.")).system).not.toContain(DESCRIPTION);
		expect((await request(f, `/skill:${NAME}`)).user).toContain(BODY);
	} finally {
		f.cleanup();
	}
});

it("does not override a native model-invocation opt-out with sidecar true", async () => {
	const f = await fixture("policy:\n  allow_implicit_invocation: true\n", {
		nativeDisabled: true,
	});
	try {
		expect((await request(f, "Explain the project.")).system).not.toContain(DESCRIPTION);
		expect((await request(f, `/skill:${NAME}`)).user).toContain(BODY);
	} finally {
		f.cleanup();
	}
});

it("does not apply Codex sidecar policy to an inferred Claude skill", async () => {
	const f = await fixture("policy:\n  allow_implicit_invocation: false\n", {
		claude: true,
	});
	try {
		expect((await request(f, "Explain the project.")).system).toContain(DESCRIPTION);
		expect((await request(f, `/skill:${NAME}`)).user).toContain(BODY);
	} finally {
		f.cleanup();
	}
});

it.each(["codex", "chatgpt", "atlas"])(
	"excludes skills restricted to vendor product %s from implicit and explicit invocation",
	async (product) => {
		const f = await fixture(`policy:\n  products: [${product}]\n`);
		try {
			expect(f.loader.getSkills().skills.some((skill) => skill.name === NAME)).toBe(false);
			expect((await request(f, "Explain the project.")).system).not.toContain(DESCRIPTION);
			const command = `/skill:${NAME}`;
			expect((await request(f, command)).user).toBe(command);
		} finally {
			f.cleanup();
		}
	},
);

it("retains metadata policy through configured Codex plugin discovery", async () => {
	const f = await fixture("policy:\n  allow_implicit_invocation: false\n", {
		plugin: true,
	});
	try {
		expect(f.loader.getSkills().skills.map((skill) => skill.name)).toContain(`policy-kit:${NAME}`);
		expect((await request(f, "Explain the project.")).system).not.toContain(DESCRIPTION);
		expect((await request(f, `/skill:policy-kit:${NAME}`)).user).toContain(BODY);
	} finally {
		f.cleanup();
	}
});

it("does not execute or connect declared dependencies during resource loading or explicit invocation", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "skill-dependency-sentinel-"));
	const sentinel = path.join(scratch, "executed");
	let connections = 0;
	const server = createServer((_request, response) => {
		connections++;
		response.end("unexpected dependency connection");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected local test port");
	const command = `${process.execPath} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed')`)}`;
	const metadata = JSON.stringify({
		policy: { allow_implicit_invocation: false },
		dependencies: {
			tools: [
				{ type: "mcp", value: "local-fixture", transport: "stdio", command },
				{
					type: "mcp",
					value: "network-fixture",
					transport: "streamable_http",
					url: `http://127.0.0.1:${address.port}/mcp`,
				},
			],
		},
	});
	const f = await fixture(metadata);
	try {
		expect(f.loader.getSkills().diagnostics).toEqual([
			expect.objectContaining({
				type: "warning",
				message: "Codex skill interface and dependency metadata are validated but not activated by this host.",
			}),
		]);
		expect((await request(f, `/skill:${NAME}`)).user).toContain(BODY);
		expect(f.harness.session.getActiveToolNames()).toEqual(["bash"]);
		expect(fs.existsSync(sentinel)).toBe(false);
		expect(connections).toBe(0);
	} finally {
		f.cleanup();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
