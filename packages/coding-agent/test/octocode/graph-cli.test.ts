import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { graphBinary, runGraphCli } from "../../src/octocode/graph/cli.ts";
import { registerGraphTools } from "../../src/octocode/graph/register.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { classify } from "../../src/octocode/permission/gate/classify.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { NATIVE_FEATURE_PATH } from "../../src/core/native-tools.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

describe("native graph CLI tools", () => {
	it("registers the CLI contract and executes build, reuse, cursor and stale queries", async () => {
		const cwd = fs.realpathSync(tmp("graph-cli-"));
		fs.writeFileSync(
			path.join(cwd, "a.ts"),
			"export function first() { return 1; }\nexport function final() { return first(); }\n",
		);
		const fake = fakePi();
		registerGraphTools(withNativePermissionOwners(fake.pi));
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
		const fake = fakePi();
		registerGraphTools(withNativePermissionOwners(fake.pi));
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
});
