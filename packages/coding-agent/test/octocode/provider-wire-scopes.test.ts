import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killEverything, outputOfRuns } from "./e2e-real-process-harness.ts";
import { providerFor, wireBox } from "./provider-wire-box.ts";
import { REPLY_TEXT, startWire, type Wire } from "./provider-wire-fake.ts";

/**
 * models.json at each scope, seen on the wire: which fake receives the request and with which key. A project file may add
 * providers but cannot send a global provider's key to another host; Pi's files are read in Pi form until OCTOCODE_HOME
 * isolates the run.
 */
vi.setConfig({ testTimeout: 180_000 });

const wires: Wire[] = [];
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	await Promise.all(wires.splice(0).map((wire) => wire.close()));
});
const fake = async () => {
	const wire = await startWire("openai-completions");
	wires.push(wire);
	return wire;
};
const provider = (wire: Wire, apiKey: string) => providerFor("openai-completions", wire, { apiKey, authHeader: true });
const bearer = (wire: Wire) => wire.seen.map((request) => request.headers.authorization);

describe("project models.json against a global provider", () => {
	it("cannot move the global provider's key to its own host: the request goes to the global baseUrl", async () => {
		const [global, project] = [await fake(), await fake()];
		const box = wireBox();
		box.writeModels({ gw: provider(global, "global-key") });
		box.writeModels({ gw: provider(project, "project-key") }, path.join(box.project, ".octocode", "models.json"));
		const result = await box.prompt("gw/model");
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(REPLY_TEXT);
		expect(bearer(global)).toEqual(["Bearer global-key"]);
		expect(project.seen).toEqual([]);
		expect(box.violations()).toEqual([]);
	});

	it("adds a provider of its own, with its own host and key", async () => {
		const [global, project] = [await fake(), await fake()];
		const box = wireBox();
		box.writeModels({ gw: provider(global, "global-key") });
		box.writeModels({ local: provider(project, "project-key") }, path.join(box.project, ".octocode", "models.json"));
		const result = await box.prompt("local/model");
		expect(result.code, result.stderr).toBe(0);
		expect(bearer(project)).toEqual(["Bearer project-key"]);
		expect(global.seen).toEqual([]);
	});

	it("is not read in a folder that is not trusted", async () => {
		const project = await fake();
		const box = wireBox();
		box.writeModels({ local: provider(project, "project-key") }, path.join(box.project, ".octocode", "models.json"));
		const run = box.start(["-p", "say hi", "--model", "local/model"], { model: false, trust: false });
		expect((await run.exited).code).not.toBe(0);
		expect(run.stderr()).toMatch(/is not trusted, so Octocode did not start here/);
		expect(run.stderr()).toMatch(/no model was called/);
		expect(project.seen).toEqual([]);
	});
});

describe("Pi's models.json", () => {
	const piFile = (home: string) => path.join(home, ".pi", "agent", "models.json");

	it("is read in Pi form from the default home", async () => {
		const pi = await fake();
		const box = wireBox();
		box.writeModels({ pi: provider(pi, "pi-key") }, piFile(box.home));
		const result = await box.prompt("pi/model");
		expect(result.code, result.stderr).toBe(0);
		expect(bearer(pi)).toEqual(["Bearer pi-key"]);
	});

	it("is ignored once OCTOCODE_HOME isolates the run", async () => {
		const pi = await fake();
		const box = wireBox();
		box.writeModels({ pi: provider(pi, "pi-key") }, piFile(box.home));
		box.env.OCTOCODE_HOME = path.join(box.root, "isolated");
		const result = await box.prompt("pi/model");
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/Model "pi\/model" not found/);
		expect(pi.seen).toEqual([]);
	});
});
