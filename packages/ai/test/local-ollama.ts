import { type ChildProcess, execFileSync, spawn } from "node:child_process";

/** The model the local Ollama tests run against. */
export const OLLAMA_MODEL = "gpt-oss:20b";

const OLLAMA_URL = "http://localhost:11434";

type Env = Readonly<Record<string, string | undefined>>;
type ListModels = () => string;

const listInstalledModels: ListModels = () =>
	execFileSync("ollama", ["list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * Whether the local Ollama tests run: only when `OCTOCODE_LOCAL_LLM=1` asks for them (`OCTOCODE_NO_LOCAL_LLM` still
 * vetoes) and `ollama list` already shows {@link OLLAMA_MODEL}. A test run never pulls the model (a multi-gigabyte
 * download): run `ollama pull gpt-oss:20b` first.
 */
export function localOllamaEnabled(env: Env = process.env, listModels: ListModels = listInstalledModels): boolean {
	if (env.OCTOCODE_LOCAL_LLM !== "1" || env.OCTOCODE_NO_LOCAL_LLM) return false;
	try {
		return listModels()
			.split("\n")
			.some((line) => line.split(/\s+/)[0] === OLLAMA_MODEL);
	} catch {
		return false;
	}
}

/** Starts `ollama serve` (a running server keeps the port; this one then exits) and waits until the API answers. */
export async function startOllama(timeoutMs: number): Promise<ChildProcess> {
	const server = spawn("ollama", ["serve"], { detached: false, stdio: "ignore" });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if ((await fetch(`${OLLAMA_URL}/api/tags`)).ok) return server;
		} catch {
			// Not listening yet.
		}
		if (Date.now() >= deadline) {
			server.kill("SIGTERM");
			throw new Error(`Ollama did not answer at ${OLLAMA_URL} within ${timeoutMs} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}
