import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/** The npm package whose Node launcher runs the FreeLlama CLI, the local Ollama gateway the `ollama` tool drives. */
export const FREELLAMA_PACKAGE = "@octocodeai/freellama";
/** A receipt is a few kilobytes; the server bounds a model's reply. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type FreellamaRunner = (
	args: string[],
	options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<unknown>;

/** The package's launcher run by this Node, or `freellama` on PATH when the package cannot be resolved. */
export function freellamaCommand(resolve: (id: string) => string = createRequire(import.meta.url).resolve): {
	file: string;
	args: string[];
} {
	try {
		const manifest = resolve(`${FREELLAMA_PACKAGE}/package.json`);
		return { file: process.execPath, args: [path.join(path.dirname(manifest), "bin", "freellama.js")] };
	} catch {
		return { file: "freellama", args: [] };
	}
}

/**
 * Run one CLI command and parse the JSON it prints. A failure carries the CLI's own stderr message, which names the
 * fix (start `freellama serve`, install the model). The CLI reads `FREELLAMA_SERVE_ENDPOINT` from this environment.
 */
export const runFreellama: FreellamaRunner = (args, { signal, timeoutMs }) => {
	const command = freellamaCommand();
	return new Promise((resolve, reject) => {
		execFile(
			command.file,
			[...command.args, ...args],
			{ signal, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					if (signal?.aborted) return reject(error);
					if ((error as NodeJS.ErrnoException).code === "ENOENT")
						return reject(new Error(`FreeLlama CLI not found: install ${FREELLAMA_PACKAGE}.`));
					if (error.killed) return reject(new Error(`freellama ${args[0]} timed out after ${timeoutMs / 1000}s.`));
					return reject(new Error(stderr.trim().replace(/^Error:\s*/, "") || error.message));
				}
				try {
					resolve(JSON.parse(stdout));
				} catch {
					reject(new Error(`freellama ${args[0]} printed no JSON receipt: ${stdout.slice(0, 200)}`));
				}
			},
		);
	});
};
