import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { readModelDataProviderIds } from "../scripts/model-data.ts";
import type { AnyModel } from "../src/types.ts";

it("scoped generation preserves other providers and historical IDs while adding new models", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "octocode-scoped-models-"));
	try {
		const preload = join(root, "fetch.mjs");
		writeFileSync(
			preload,
			`
globalThis.fetch = async (input) => {
 const url = String(input);
 if (url === "https://models.dev/api.json") return Response.json({opencode:{models:{"scope-test-new-model":{name:"New model",tool_call:true}}}});
 if (url === "https://models.dev/models.json?type=decision") return Response.json({"typesafe/jev-latest":{name:"Jev",type:"decision"}});
 if (url === "https://radius.pi.dev/v1/config") return Response.json({baseUrl:"https://radius.pi.dev",models:[{id:"test",name:"Test",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:4096}]});
 if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({data:[]});
 throw new Error("Unexpected network request: " + url);
};
`,
		);
		const output = join(root, "catalog");
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--providers",
				"opencode",
				"--json-only",
				"--json-output",
				output,
			],
			{ cwd: packageRoot, encoding: "utf8", timeout: 10000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).toBe("");
		for (const provider of readModelDataProviderIds(packageRoot)) {
			const groups = JSON.parse(
				readFileSync(join(packageRoot, "src/providers/data", `${provider}.json`), "utf8"),
			) as Record<string, Record<string, AnyModel>>;
			const before = Object.values(groups).flatMap(Object.values);
			const after = JSON.parse(
				readFileSync(join(output, "providers", `${provider}.all.json`), "utf8"),
			) as AnyModel[];
			for (const model of before)
				expect(after.find((entry) => entry.id === model.id && entry.type === model.type)).toEqual(model);
			expect(after).toHaveLength(before.length + (provider === "opencode" ? 1 : 0));
			if (provider === "opencode")
				expect(after.find((model) => model.id === "scope-test-new-model")?.baseUrl).toBe(
					"https://opencode.ai/inference/openai/v1",
				);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
