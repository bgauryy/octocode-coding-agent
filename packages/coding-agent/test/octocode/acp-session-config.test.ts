import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpBackend } from "../../../acp/src/client/client.ts";
import { acpModels, modelRefusal } from "../../../acp/src/client/session-config.ts";
import { acpClientHost } from "../../src/octocode/external/acp-host.ts";

const fixture = fileURLToPath(new URL("./fixtures/acp-config-agent.mjs", import.meta.url));
const cancelled = async () => ({ outcome: { outcome: "cancelled" as const } });
const backends: AcpBackend[] = [];
const roots: string[] = [];

async function connect(model?: string, mode = "modern", signal?: AbortSignal, timeoutMs = 30_000) {
	const cwd = mkdtempSync(join(tmpdir(), "acp-config-"));
	roots.push(cwd);
	const backend = await AcpBackend.connect(
		acpClientHost,
		{ command: process.execPath, args: [fixture, mode], vendor: "fixture", cwd, model, timeoutMs },
		cancelled,
		signal,
	);
	backends.push(backend);
	return backend;
}

afterEach(async () => {
	await Promise.allSettled(backends.splice(0).map((backend) => backend.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ACP model state", () => {
	it("reads the model-category select, flattening groups, before an option merely named model", () => {
		const state = acpModels({
			configOptions: [
				{ id: "model", name: "Old", type: "select", currentValue: "x", options: [{ value: "x", name: "x" }] },
				{
					id: "pick",
					name: "Model",
					category: "model",
					type: "select",
					currentValue: "b",
					options: [
						{ group: "g1", name: "G1", options: [{ value: "a", name: "A" }] },
						{ group: "g2", name: "G2", options: [{ value: "b", name: "B" }] },
					],
				},
			],
		});
		expect(state).toEqual({ current: "b", available: ["a", "b"], configId: "pick" });
	});

	it("accepts only advertised IDs from the legacy models field", () => {
		const state = acpModels({
			configOptions: [],
			models: { currentModelId: "m2", availableModels: [{ modelId: "m1" }, { modelId: "m2" }, { name: "no id" }] },
		});
		expect(state).toEqual({ current: "m2", available: ["m1", "m2"] });
		expect(modelRefusal(state, "m1")).toBeUndefined();
		expect(modelRefusal(state, "missing")).toContain('has no model "missing"');
		expect(acpModels({})).toBeUndefined();
		expect(modelRefusal(undefined, "m1")).toBe("ACP agent offers no model option; connect without model.");
	});

	it("refuses a model the option does not offer and names what it does", () => {
		const state = { current: "a", available: ["a", "b"], configId: "model" };
		expect(modelRefusal(state, "b")).toBeUndefined();
		expect(modelRefusal(state, "c")).toBe('ACP agent has no model "c"; it offers a, b.');
	});
});

describe("ACP backend models", () => {
	it("reports the session's model and the values its model option accepts", async () => {
		const backend = await connect();
		expect(backend.models).toEqual({ current: "small", available: ["small", "large"], configId: "model-choice" });
	});

	it("sets a requested model through session/set_config_option before returning the connection", async () => {
		const backend = await connect("large");
		expect(backend.models?.current).toBe("large");
	});

	it("fails the connection for a model the agent does not offer instead of running on another", async () => {
		await expect(connect("huge")).rejects.toThrow(
			'ACP connection failed during session/set_config_option: ACP agent has no model "huge"; it offers small, large.',
		);
	});

	it("keeps command catalogs out of the reply and follows config updates", async () => {
		const backend = await connect();
		const reply = await backend.prompt("hello", { timeoutMs: 30_000 });
		expect(reply.text).toBe("started on small");
		const kinds = (reply.updates ?? []).map((entry) => {
			const update = (entry as { update?: { sessionUpdate?: string } }).update;
			return update?.sessionUpdate ?? (entry as { type?: string }).type;
		});
		expect(kinds).not.toContain("available_commands_update");
		expect(kinds).not.toContain("config_option_update");
		expect(kinds).toContain("agent_message_chunk");
		expect(backend.models?.current).toBe("large");
	});
});

function requests() {
	const path = join(roots.at(-1)!, "requests.jsonl");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { method: string; pid: number })
		: [];
}
function expectStopped() {
	const pid = requests()[0]?.pid;
	expect(pid).toBeTypeOf("number");
	expect(() => process.kill(pid, 0)).toThrow();
}

describe("ACP legacy model compatibility", () => {
	it("sets an advertised legacy model before the first prompt", async () => {
		const backend = await connect("large", "legacy");
		expect(backend.models).toEqual({ current: "large", available: ["small", "large"] });
		expect((await backend.prompt("hello", { timeoutMs: 30_000 })).text).toBe("started on large");
		expect(requests().map((row) => row.method)).toEqual(["new", "set_model", "prompt"]);
	});
	it("prefers modern configuration when both catalogs are present", async () => {
		await connect("large");
		expect(requests().map((row) => row.method)).toEqual(["new", "set_config_option"]);
	});
	it("rejects unknown legacy models without selection or prompt and stops the child", async () => {
		await expect(connect("huge", "legacy")).rejects.toThrow('has no model "huge"');
		expect(requests().map((row) => row.method)).toEqual(["new"]);
		expectStopped();
	});
	it.each(["legacy-reject", "modern-reject"])("propagates %s without falling back or prompting", async (mode) => {
		await expect(connect("large", mode)).rejects.toThrow("selection denied");
		expect(requests().map((row) => row.method)).toEqual([
			"new",
			mode.startsWith("legacy") ? "set_model" : "set_config_option",
		]);
		expectStopped();
	});
	it("aborts a pending legacy selection and stops the child", async () => {
		const controller = new AbortController();
		const pending = connect("large", "legacy-hang", controller.signal).then(
			() => undefined,
			(error) => error,
		);
		await vi.waitFor(() => expect(requests().map((row) => row.method)).toContain("set_model"));
		controller.abort(new Error("stop selection"));
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("stop selection");
		expect(requests().map((row) => row.method)).not.toContain("prompt");
		expectStopped();
	});
});
