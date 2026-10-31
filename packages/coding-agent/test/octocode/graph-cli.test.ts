import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import { cachedGraphSchema, graphBinary, graphSchema, runGraphCli } from "../../src/octocode/graph/cli.ts";
import { registerGraphTools } from "../../src/octocode/graph/register.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { classify } from "../../src/octocode/permission/gate/classify.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { NATIVE_FEATURE_PATH } from "../../src/core/native-tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("native graph CLI tools", () => {
	it("hoists CLI definitions once and rejects unknown envelope fields", async () => {
		const fake = fakeHost();
		await registerGraphTools(withNativePermissionOwners(fake.api));
		for (const name of ["graphBuild", "graphQuery"]) {
			const tool = fake.tools.get(name);
			// Shared definitions live at the root, and every reference resolves there (a tool with none shares none).
			const defs = tool.parameters.$defs ?? {};
			for (const ref of JSON.stringify(tool.parameters).match(/#\/\$defs\/[^"]+/g) ?? [])
				expect(defs).toHaveProperty([ref.slice("#/$defs/".length)]);
			expect(tool.parameters.properties.request).not.toHaveProperty("$defs");
			const request: JsonObject = { queries: [name === "graphBuild" ? { path: "." } : { operation: "stats" }] };
			const validate = (args: JsonObject) =>
				validateToolArguments(tool, { type: "toolCall", id: "s", name, arguments: args });
			expect(() => validate({ request, reason: "Inspect dependencies" })).not.toThrow();
			expect(() => validate({ request, reason: "Inspect dependencies", ignored: true })).toThrow();
		}
	});

	it("registers the CLI contract and executes build, reuse, cursor and stale queries", async () => {
		const cwd = fs.realpathSync(tmp("graph-cli-"));
		fs.writeFileSync(
			path.join(cwd, "a.ts"),
			"export function first() { return 1; }\nexport function final() { return first(); }\n",
		);
		const fake = fakeHost();
		await registerGraphTools(withNativePermissionOwners(fake.api));
		const build = fake.tools.get("graphBuild");
		const query = fake.tools.get("graphQuery");
		expect(build).toBeDefined();
		expect(query.description).toContain("lspSearch");
		const ctx = fakeCtx({ cwd });
		const params = { request: { queries: [{ path: "." }] }, reason: "Inspect dependencies" };
		expect(() =>
			validateToolArguments(build, { type: "toolCall", id: "g", name: "graphBuild", arguments: params }),
		).not.toThrow();
		const created = await build.execute("g", params, undefined, undefined, ctx);
		const first = created.details.results[0].data;
		expect(created.isError).toBe(false);
		expect(fs.existsSync(path.resolve(cwd, first.dir, "graph.bin"))).toBe(true);
		expect(path.resolve(cwd, first.dir)).toContain(path.join(cwd, ".octocode", "graph"));
		const reused = await build.execute("r", params, undefined, undefined, ctx);
		expect(reused.details.results[0].data).toMatchObject({ id: first.id, reused: true });
		let request: Record<string, unknown> = { queries: [{ operation: "find", target: "f", graph: first.id, limit: 1 }] };
		const rows: unknown[] = [];
		for (let page = 0; page < 10; page++) {
			const result = await query.execute("q", { request, reason: "Follow graph evidence" }, undefined, undefined, ctx);
			expect(result.isError).toBe(false);
			const data = result.details.results[0].data;
			expect(data.graph.id).toBe(first.id);
			rows.push(...data.results);
			if (!data.next?.page) {
				expect(rows).toHaveLength(data.total);
				break;
			}
			request = data.next.page.input;
			expect(request).toHaveProperty("cursor");
		}
		expect(rows.length).toBeGreaterThanOrEqual(2);
		fs.appendFileSync(path.join(cwd, "a.ts"), "export const added = 2;\n");
		const stale = await query.execute(
			"s",
			{ request: { queries: [{ operation: "stats", graph: first.id }] } },
			undefined,
			undefined,
			ctx,
		);
		expect(stale.details.results[0].data.freshness.fresh).toBe(false);
	}, 30_000);

	it("rejects invalid input, confines scope and honours cancellation", async () => {
		const cwd = fs.realpathSync(tmp("graph-refusal-"));
		const binary = graphBinary();
		const invalid = await runGraphCli(binary, "graphQuery", { queries: [{ operation: "unknown" }] }, cwd, false);
		expect(invalid.isError).toBe(true);
		const fake = fakeHost();
		await registerGraphTools(withNativePermissionOwners(fake.api));
		const query = fake.tools.get("graphQuery");
		const invalidRows: Record<string, string>[] = [
			{ operation: "find" },
			{ operation: "path", target: "a.ts" },
			{ operation: "impact" },
			{ operation: "drift" },
			{ operation: "stats", target: "ignored" },
		];
		for (const row of invalidRows) {
			const arguments_ = { request: { queries: [row] }, reason: "Check required graph inputs" };
			expect(() =>
				validateToolArguments(query, { type: "toolCall", id: "q", name: "graphQuery", arguments: arguments_ }),
			).toThrow();
			const rejected = await runGraphCli(binary, "graphQuery", arguments_.request, cwd, false);
			expect(rejected.isError).toBe(true);
			expect(JSON.stringify(rejected.output)).toContain("invalidInput");
		}
		const outside = await runGraphCli(binary, "graphBuild", { queries: [{ path: ".." }] }, cwd, false);
		expect(outside.isError).toBe(true);
		const controller = new AbortController();
		controller.abort();
		await expect(runGraphCli(binary, "graphBuild", { queries: [{}] }, cwd, false, controller.signal)).rejects.toThrow();
		expect(fs.existsSync(path.join(cwd, ".octocode", "graph", "latest"))).toBe(false);
	});

	it("classifies builds as workspace writes and permits queries in plan mode", () => {
		const event = { toolName: "graphBuild", input: { request: { queries: [{}] } }, toolCallId: "g" };
		expect(classify(event as never, { cwd: "/workspace" })?.action).toBe("file.workspace");
		const definition = { sourceInfo: { path: NATIVE_FEATURE_PATH } } as never;
		expect(planningRefusal(event, definition)).toContain("blocks graphBuild");
		expect(planningRefusal({ ...event, toolName: "graphQuery" }, definition)).toBeUndefined();
	});
	describe("schema cache", () => {
		/** A stand-in CLI that prints a fixed schema and appends a line to `calls` for each invocation. */
		function fakeCli(label: string, wait = "") {
			const dir = fs.realpathSync(tmp("graph-schema-"));
			const calls = path.join(dir, "calls");
			const binary = path.join(dir, `cli-${label}`);
			fs.writeFileSync(
				binary,
				`#!/bin/sh\necho "$2" >> "${calls}"\n${wait}echo '{"inputSchema":{"type":"object","properties":{"tool":{"const":"'$2'"}}},"description":"'$2' from ${label}"}'\n`,
				{ mode: 0o755 },
			);
			const count = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").length : 0);
			return { dir, binary, count };
		}

		it("asks the CLI once per binary build and serves later processes from disk", async () => {
			const a = fakeCli("a");
			const b = fakeCli("b");
			const cacheA = path.join(a.dir, "cache", "graph-schemas.json");
			const cacheB = path.join(b.dir, "cache", "graph-schemas.json");

			const build = await graphSchema(a.binary, "graphBuild", a.dir, cacheA);
			expect(build.description).toBe("graphBuild from a");
			expect((await graphSchema(a.binary, "graphQuery", a.dir, cacheA)).description).toBe("graphQuery from a");
			expect(a.count()).toBe(2);
			expect(fs.existsSync(cacheA)).toBe(true);

			// Another binary resets the in-memory copy, as a new process would start without it.
			await graphSchema(b.binary, "graphBuild", b.dir, cacheB);
			expect(cachedGraphSchema(a.binary, "graphBuild", cacheA)).toEqual(build);
			expect(await graphSchema(a.binary, "graphBuild", a.dir, cacheA)).toEqual(build);
			expect((await graphSchema(a.binary, "graphQuery", a.dir, cacheA)).description).toBe("graphQuery from a");
			expect(a.count()).toBe(2);
		});

		it("reports no cached schema before the CLI has been asked", () => {
			const a = fakeCli("f");
			expect(cachedGraphSchema(a.binary, "graphBuild", path.join(a.dir, "none.json"))).toBeUndefined();
			expect(a.count()).toBe(0);
		});

		it("fetches without blocking the event loop and shares one run between concurrent callers", async () => {
			const a = fakeCli("g", "sleep 0.4\n");
			const cache = path.join(a.dir, "cache.json");
			let ticks = 0;
			const timer = setInterval(() => ticks++, 20);
			try {
				const [build, query] = await Promise.all([
					graphSchema(a.binary, "graphBuild", a.dir, cache),
					graphSchema(a.binary, "graphQuery", a.dir, cache),
				]);
				expect(build.description).toBe("graphBuild from g");
				expect(query.description).toBe("graphQuery from g");
			} finally {
				clearInterval(timer);
			}
			expect(ticks).toBeGreaterThanOrEqual(5);
			expect(a.count()).toBe(2);
		});

		it("stops the CLI when aborted and stores nothing", async () => {
			const a = fakeCli("h", "exec sleep 30\n");
			const cache = path.join(a.dir, "cache.json");
			const controller = new AbortController();
			const pending = graphSchema(a.binary, "graphBuild", a.dir, cache, controller.signal);
			setTimeout(() => controller.abort(), 50);
			await expect(pending).rejects.toThrow();
			expect(fs.existsSync(cache)).toBe(false);
			await expect(graphSchema(a.binary, "graphBuild", a.dir, cache, AbortSignal.abort())).rejects.toThrow();
		});

		it("refetches when the binary changes, the file is stale or the file is damaged", async () => {
			const a = fakeCli("c");
			const cache = path.join(a.dir, "cache", "graph-schemas.json");
			const other = fakeCli("d");
			await graphSchema(a.binary, "graphBuild", a.dir, cache);
			expect(a.count()).toBe(2);

			fs.appendFileSync(a.binary, "# rebuilt\n");
			await graphSchema(other.binary, "graphBuild", other.dir, path.join(other.dir, "cache.json"));
			await graphSchema(a.binary, "graphBuild", a.dir, cache);
			expect(a.count()).toBe(4);

			await graphSchema(other.binary, "graphBuild", other.dir, path.join(other.dir, "cache.json"));
			fs.writeFileSync(cache, "{not json");
			await graphSchema(a.binary, "graphBuild", a.dir, cache);
			expect(a.count()).toBe(6);
			expect(JSON.parse(fs.readFileSync(cache, "utf8")).schemas.graphQuery.description).toBe("graphQuery from c");
		});

		it("still returns the schema when the cache cannot be written", async () => {
			const a = fakeCli("e");
			const blocker = path.join(a.dir, "blocked");
			fs.writeFileSync(blocker, "a file where a directory is needed");
			const schema = await graphSchema(a.binary, "graphQuery", a.dir, path.join(blocker, "graph-schemas.json"));
			expect(schema.description).toBe("graphQuery from e");
		});
	});
});
