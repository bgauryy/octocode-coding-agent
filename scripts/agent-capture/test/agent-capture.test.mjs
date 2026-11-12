import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { captureEnv, trackedOutputReason } from "../capture.mjs";
import { escapeReport } from "../esc-report.mjs";
import { startMock } from "../mock.mjs";
import { formatSizes, measureRequest, requestFiles } from "../request-size.mjs";

const KIT = resolve(import.meta.dirname, "..");
const REPO = resolve(KIT, "..", "..");
const roots = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-capture-"));
	roots.push(dir);
	return dir;
};
after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("sizes an Anthropic request: system blocks, a system message and tool schemas as compact JSON", () => {
	const schema = { type: "object", properties: { command: { type: "string" } } };
	const size = measureRequest({
		method: "POST",
		url: "/v1/messages",
		body: {
			system: [
				{ type: "text", text: "core" },
				{ type: "text", text: "more" },
			],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{ role: "system", content: "context" },
			],
			tools: [{ name: "Bash", description: "Runs it", input_schema: schema }],
		},
	});
	assert.deepEqual(
		{ ...size, tools: undefined },
		{
			system: 8,
			messages: 12,
			toolDescriptions: 7,
			toolSchemas: JSON.stringify(schema).length,
			total: 27 + JSON.stringify(schema).length,
			tools: undefined,
		},
	);
	assert.equal(size.tools[0].name, "Bash");
});

test("sizes an OpenAI Responses request: tools in an additional_tools item and namespaces, a grammar as a schema", () => {
	const format = { type: "grammar", definition: "start: x" };
	const size = measureRequest({
		instructions: "base",
		input: [
			{
				type: "additional_tools",
				tools: [
					{
						type: "namespace",
						name: "functions",
						tools: [{ type: "custom", name: "exec", description: "JS", format }],
					},
				],
			},
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
		],
		tools: [{ type: "function", name: "shell", description: "sh", strict: false, parameters: { type: "object" } }],
	});
	assert.equal(size.system, 4);
	assert.equal(size.messages, 5);
	assert.equal(size.toolDescriptions, 4);
	assert.equal(size.toolSchemas, JSON.stringify({ format }).length + JSON.stringify({ type: "object" }).length);
	assert.deepEqual(
		size.tools.map((tool) => tool.name),
		["exec", "shell"],
	);
});

test("sizes Octocode's rendered request and lists a folder of agents", () => {
	const dir = scratch();
	mkdirSync(join(dir, "main"));
	writeFileSync(
		join(dir, "main", "request.json"),
		JSON.stringify({
			system: "abc",
			tools: [{ name: "file", description: "d", parameters: {} }],
			messages: [{ role: "user", text: "hi" }],
		}),
	);
	const [entry] = requestFiles(dir);
	assert.ok(entry.label.endsWith("/main"));
	const size = measureRequest(JSON.parse(readFileSync(entry.file, "utf8")));
	assert.deepEqual([size.system, size.messages, size.toolDescriptions, size.toolSchemas], [3, 2, 1, 0]);
	assert.match(formatSizes([{ label: "main", size }], { tools: true }), /\| main \| 3 \| 2 \| 1 \| 0 \| 6 \| 1 \|/);
});

test("the mock logs a request with its key redacted and streams an answer or one shell call", async () => {
	const dir = scratch();
	const mock = await startMock({ dir, tool: true });
	try {
		const ask = (tools) =>
			fetch(`http://127.0.0.1:${mock.port}/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": "secret-key", "content-type": "application/json" },
				body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }], tools }),
			}).then((response) => response.text());
		assert.match(await ask([]), /"text":"OK"/);
		assert.match(await ask([{ name: "Bash" }]), /"type":"tool_use".*"name":"Bash"/s);
	} finally {
		await mock.close();
	}
	const logged = JSON.parse(readFileSync(join(dir, "001.json"), "utf8"));
	assert.equal(logged.headers["x-api-key"], "<redacted>");
	assert.equal(logged.body.messages[0].content, "hi");
	assert.ok(!readFileSync(join(dir, "001.json"), "utf8").includes("secret-key"));
});

test("the client environment keeps no real key, home or proxy and sends every other host to the dead proxy", () => {
	const env = captureEnv(
		{
			PATH: "/bin",
			HOME: "/Users/me",
			ANTHROPIC_API_KEY: "real",
			GITHUB_TOKEN: "real",
			HTTPS_PROXY: "http://corp:8080",
		},
		{ home: "/tmp/h", port: 1234, proxyPort: 9 },
	);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/tmp/h");
	assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-mock");
	assert.equal(env.GITHUB_TOKEN, undefined);
	assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1234");
	for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY"])
		assert.equal(env[key], "http://127.0.0.1:9");
	assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("raw captures may go to an ignored folder or outside the repository, never to a tracked one", () => {
	assert.equal(trackedOutputReason(join(REPO, ".octocode", "tmp", "agent-capture", "x"), REPO), undefined);
	assert.equal(trackedOutputReason(join(tmpdir(), "x"), REPO), undefined);
	assert.match(trackedOutputReason(join(REPO, "scripts", "agent-capture", "out"), REPO) ?? "", /not ignored by Git/);
});

const cli = (...args) => spawnSync(process.execPath, [join(KIT, "capture.mjs"), ...args], { encoding: "utf8" });

test("refuses to run when something listens on the dead proxy port", async () => {
	const server = createServer();
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const out = join(scratch(), "run");
	try {
		const { port } = server.address();
		// The listener must answer while the CLI probes it, so the CLI runs asynchronously.
		const result = await new Promise((done) =>
			execFile(
				process.execPath,
				[join(KIT, "capture.mjs"), "--out", out, "--dead-proxy-port", String(port), "s", "--", "true"],
				(error, _stdout, stderr) => done({ code: error?.code ?? 0, stderr }),
			),
		);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /dead proxy/);
		assert.equal(existsSync(out), false);
	} finally {
		server.close();
	}
});

test("refuses a tracked output folder", () => {
	const result = cli("--out", join(KIT, "out"), "s", "--", "true");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /not ignored by Git/);
});

test("captures what a client sends, in a seeded home and a fresh repository", () => {
	const out = join(scratch(), "run");
	const client = `
		const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
			method: "POST",
			headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "content-type": "application/json" },
			body: JSON.stringify({ model: "m", system: "sys", messages: [{ role: "user", content: "hi" }] }),
		});
		console.log(response.status, process.cwd());`;
	const result = cli(
		"--out",
		out,
		"--dead-proxy-port",
		"9",
		"probe",
		"--",
		process.execPath,
		"--input-type=module",
		"--eval",
		client,
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /1 request\(s\), client exit 0/);
	assert.match(result.stdout, /\| requests\/001\.json \| 3 \| 2 \|/);
	assert.match(readFileSync(join(out, "stdout.txt"), "utf8"), /^200 .*work\nexit 0\n$/);
	assert.ok(existsSync(join(out, "work", ".git")));
	assert.match(readFileSync(join(out, "home", ".codex", "config.toml"), "utf8"), /supports_websockets = false/);
	const models = JSON.parse(readFileSync(join(out, "home", ".octocode", "agent", "models.json"), "utf8"));
	assert.match(models.providers.anthropic.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
	assert.equal(models.providers.anthropic.compat.supportsLongCacheRetention, true);
});

test("reports the terminal features in a recording", () => {
	const lines = escapeReport("\x1b[?1049h\x1b[?2004h\x1b]7501;state=working\x07\x1b[>1u\x1b[?1049l");
	assert.ok(lines.includes("DECSET ?1049h x1  alt screen"));
	assert.ok(lines.includes("DECSET ?1049l x1  alt screen"));
	assert.ok(lines.includes("OSC 7501 x1  program status"));
	assert.ok(lines.includes("kitty keyboard push CSI >Nu x1"));
});

test(
	"extracts prose string literals from the sources it is given",
	{ skip: spawnSync("python3", ["--version"]).status !== 0 },
	() => {
		const dir = scratch();
		const src = join(dir, "src");
		mkdirSync(src);
		const prose = Array.from({ length: 40 }, (_, index) => `word${String.fromCharCode(97 + (index % 26))}x`).join(" ");
		writeFileSync(join(src, "a.js"), `const a = "${prose}"; const b = "short";\n`);
		const out = join(dir, "prompts.jsonl");
		const result = spawnSync("python3", ["-I", join(KIT, "extract-prompts.py"), src, out, "100"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const rows = readFileSync(out, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			rows.map((row) => [row.file, row.text]),
			[["a.js", prose]],
		);
	},
);
