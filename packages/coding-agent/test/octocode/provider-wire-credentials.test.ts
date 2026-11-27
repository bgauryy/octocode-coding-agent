import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox, type WireBox } from "./provider-wire-box.ts";
import { REPLY_TEXT, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * Where a key comes from, and what a refused key does, seen on the wire: the `Authorization` header of the request the
 * real CLI sends for each key source in models.json, and the single re-run of a key command after a 401.
 */
vi.setConfig({ testTimeout: 180_000 });

let wire: Wire | undefined;
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await wire?.close();
	wire = undefined;
});

const bearer = (headers: Record<string, unknown>) => String(headers.authorization);

async function setup(fields: Record<string, unknown>, replies?: Parameters<typeof startWire>[1]) {
	wire = await startWire("openai-completions", replies);
	const box = wireBox();
	const { apiKey: _drop, ...rest } = providerFor("openai-completions", wire, { authHeader: true });
	box.writeModels({ gw: { ...rest, ...fields } });
	return box;
}

/** A program that counts its runs in a file and prints `key-<run>`. */
function counterCommand(box: WireBox): { command: string; args: string[]; runs: () => number } {
	const counter = path.join(box.root, "runs");
	const script = path.join(box.root, "key.cjs");
	fs.writeFileSync(
		script,
		`const fs=require("node:fs");const f=process.argv[2];const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;fs.writeFileSync(f,String(n));process.stdout.write("key-"+n+"\\n");`,
	);
	return {
		command: process.execPath,
		args: [script, counter],
		runs: () => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0),
	};
}

describe("key sources reach the Authorization header", () => {
	it("a literal apiKey", async () => {
		const box = await setup({ apiKey: "literal-key" });
		const result = await box.prompt("gw/model");
		expect(result.code, result.stderr).toBe(0);
		expect(bearer(wire!.seen[0].headers)).toBe("Bearer literal-key");
		expect(box.violations()).toEqual([]);
	});

	it("an environment variable named in env", async () => {
		const box = await setup({ env: ["WIRE_UNSET_KEY", "WIRE_SET_KEY"] });
		box.env.WIRE_SET_KEY = "from-env";
		const result = await box.prompt("gw/model");
		expect(result.code, result.stderr).toBe(0);
		expect(bearer(wire!.seen[0].headers)).toBe("Bearer from-env");
	});

	it("a `!command` apiKey, run without being logged", async () => {
		const box = await setup({ apiKey: `!${JSON.stringify(process.execPath)} -e 'process.stdout.write("cmd-key")'` });
		const result = await box.prompt("gw/model");
		expect(result.code, result.stderr).toBe(0);
		expect(bearer(wire!.seen[0].headers)).toBe("Bearer cmd-key");
		expect(result.stdout + result.stderr).not.toContain("cmd-key");
	});

	it("env wins over a literal apiKey", async () => {
		const box = await setup({ apiKey: "literal", env: ["WIRE_SET_KEY"] });
		box.env.WIRE_SET_KEY = "from-env";
		const result = await box.prompt("gw/model");
		expect(result.code, result.stderr).toBe(0);
		expect(bearer(wire!.seen[0].headers)).toBe("Bearer from-env");
	});

	it("the auth command wins over env and apiKey together", async () => {
		const box = await setup({ apiKey: "literal", env: ["WIRE_SET_KEY"] });
		box.env.WIRE_SET_KEY = "from-env";
		box.writeModels({
			gw: {
				...(JSON.parse(fs.readFileSync(path.join(box.home, ".octocode", "octocodecode", "models.json"), "utf8"))
					.providers.gw as object),
				auth: (({ command, args }) => ({ command, args }))(counterCommand(box)),
			},
		});
		const first = await box.prompt("gw/model");
		expect(first.code, first.stderr).toBe(0);
		expect(bearer(wire!.seen[0].headers)).toBe("Bearer key-1");
	});
});

describe("a key the provider refuses", () => {
	it("re-runs the key command once and sends the new key", async () => {
		const box = await setup({}, [{ status: 401 }, "ok"]);
		const counter = counterCommand(box);
		box.writeModels({
			gw: { ...providerFor("openai-completions", wire!, { authHeader: true }), apiKey: undefined, auth: counter },
		});
		const result = await box.prompt("gw/model");
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(REPLY_TEXT);
		expect(wire!.seen.map((request) => bearer(request.headers))).toEqual(["Bearer key-1", "Bearer key-2"]);
		expect(counter.runs()).toBe(2);
	});

	it("fails with the provider named and never prints the key, after one re-run", async () => {
		const box = await setup({}, [{ status: 401 }]);
		const counter = counterCommand(box);
		box.writeModels({
			gw: { ...providerFor("openai-completions", wire!, { authHeader: true }), apiKey: undefined, auth: counter },
		});
		const result = await box.prompt("gw/model");
		expect(result.code).not.toBe(0);
		expect(counter.runs()).toBe(2);
		expect(result.stdout + result.stderr).not.toMatch(/key-\d/);
		expect(result.stderr).toMatch(/401|gw/);
	});

	it("a literal key refused with 401 is not retried with the same key forever", async () => {
		const box = await setup({ apiKey: "bad-key" }, [{ status: 401 }]);
		const result = await box.prompt("gw/model");
		expect(result.code).not.toBe(0);
		expect(wire!.seen.length).toBeLessThanOrEqual(2);
		expect(result.stderr).toMatch(/401|gw/);
	});
});
