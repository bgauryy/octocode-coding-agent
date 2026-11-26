import fs from "node:fs";
import path from "node:path";
import { type Endpoint, type Sandbox, sandbox, until } from "./e2e-real-process-harness.ts";
import { baseSuffix, type Family, networkGuard, type Wire } from "./provider-wire-fake.ts";

/** A model entry every family accepts; no credentials are in it. */
export const modelEntry = (id = "model") => ({
	id,
	name: id,
	contextWindow: 200000,
	maxTokens: 8000,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
});

/** The `models.json` provider a user writes for a wire fake; `fields` add or replace keys (a different key source, rates). */
export const providerFor = (family: Family, wire: Wire, fields: Record<string, unknown> = {}) => ({
	baseUrl: `${wire.url}${baseSuffix(family)}`,
	api: family,
	apiKey: "wire-key",
	models: [modelEntry()],
	...fields,
});

export interface WireBox extends Sandbox {
	/** Writes `models.json` into a folder (the global file by default, else the path under the home or project). */
	writeModels(providers: Record<string, unknown>, file?: string): void;
	/** Socket attempts to a non-loopback host: must stay empty. */
	violations(): string[];
	/** Starts an RPC session on `model`; commands go in as JSON lines and every record the CLI printed comes back. */
	rpc(model: string, args?: string[]): RpcSession;
	/** Runs one headless prompt on `provider/model` and waits for the exit. */
	prompt(model: string, text?: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface RpcSession {
	records(): Array<Record<string, any>>;
	/** Sends a command and waits for its response record. */
	command(command: Record<string, unknown>): Promise<Record<string, any>>;
	/** Waits until `condition` holds over the records. */
	when(condition: () => boolean, label: string, ms?: number): Promise<void>;
	stdout(): string;
	stderr(): string;
}

const noEndpoint: Endpoint = { url: "http://127.0.0.1:1/v1", requests: [], close: async () => undefined };

/** An isolated home and git project on the real CLI, with the network guard on and no provider configured yet. */
export function wireBox(): WireBox {
	const box = sandbox(noEndpoint);
	// The shared sandbox turns the request window off for scripted runs; a wire run keeps the product default.
	const settingsFile = path.join(box.home, ".octocode", "octocodecode", "settings.json");
	const { requestsPerMinute: _off, ...kept } = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<
		string,
		unknown
	>;
	fs.writeFileSync(settingsFile, JSON.stringify(kept));
	const guard = networkGuard();
	Object.assign(box.env, guard.env);
	const write = (providers: Record<string, unknown>, file?: string) => {
		const target = file ?? path.join(box.home, ".octocode", "octocodecode", "models.json");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({ providers }));
		fs.chmodSync(target, 0o600);
	};
	write({});
	return Object.assign(box, {
		writeModels: write,
		violations: guard.violations,
		rpc(model: string, args: string[] = []) {
			const run = box.start(["--mode", "rpc", "--model", model, ...args], { model: false, stdin: "pipe" });
			const records = () =>
				run
					.stdout()
					.split("\n")
					.filter((line) => line.startsWith("{"))
					.map((line) => JSON.parse(line) as Record<string, any>);
			let next = 0;
			const session: RpcSession = {
				records,
				stdout: run.stdout,
				stderr: run.stderr,
				when: (condition, label, ms) => until(condition, label, ms),
				async command(command) {
					const id = `c${++next}`;
					run.process.stdin?.write(`${JSON.stringify({ id, ...command })}\n`);
					await until(() => records().some((r) => r.type === "response" && r.id === id), `response to ${id}`);
					return records().find((r) => r.type === "response" && r.id === id)!;
				},
			};
			return session;
		},
		async prompt(model: string, text = "say hi") {
			const run = box.start(["-p", text, "--model", model], { model: false });
			const { code } = await run.exited;
			return { code, stdout: run.stdout(), stderr: run.stderr() };
		},
	});
}
