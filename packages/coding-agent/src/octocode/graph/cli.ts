import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { getNativeBinaryPath } from "../../config.ts";
import { adoptTree, killTree, prepareTree } from "../shared/process.ts";
import { isRecord } from "../../utils/guards.ts";
import { defaultSchemaCacheFile, type GraphSchema, readSchemaCache, writeSchemaCache } from "./schema-cache.ts";

export const GRAPH_TOOLS = ["graphBuild", "graphQuery"] as const;
export type GraphTool = (typeof GRAPH_TOOLS)[number];

export const graphBinary = (): string => getNativeBinaryPath();

function environment(cwd: string, trusted: boolean): NodeJS.ProcessEnv {
	return {
		...process.env,
		WORKSPACE_ROOT: cwd,
		ALLOWED_PATHS: cwd,
		OCTOCODE_TRUST_PROJECT_LSP_CONFIG: String(trusted),
	};
}

const schemas = new Map<string, GraphSchema>();
let binaryStamp = "";

function fetchSchema(binary: string, name: GraphTool, cwd: string): GraphSchema {
	const output = execFileSync(binary, ["schema", name, "--view", "query"], {
		cwd,
		env: environment(cwd, false),
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
	});
	const schema: unknown = JSON.parse(output);
	if (!isRecord(schema) || !isRecord(schema.inputSchema) || typeof schema.description !== "string")
		throw new Error(`Octocode CLI did not return a schema for ${name}; rebuild or update Octocode.`);
	return { inputSchema: schema.inputSchema, description: schema.description };
}

/**
 * The CLI's contract for one graph tool. It is read from memory, else from the on-disk cache of this binary's stamp,
 * else from the CLI itself, which then stores every tool's schema so only the first start after a new build pays.
 */
export function graphSchema(
	binary: string,
	name: GraphTool,
	cwd: string,
	cacheFile: string = defaultSchemaCacheFile(),
): GraphSchema {
	const stat = statSync(binary);
	const stamp = `${binary}:${stat.size}:${stat.mtimeMs}`;
	if (binaryStamp !== stamp) {
		schemas.clear();
		binaryStamp = stamp;
		for (const [tool, schema] of Object.entries(readSchemaCache(cacheFile, stamp) ?? {})) schemas.set(tool, schema);
	}
	const cached = schemas.get(name);
	if (cached) return cached;
	for (const tool of GRAPH_TOOLS) {
		if (!schemas.has(tool)) schemas.set(tool, fetchSchema(binary, tool, cwd));
	}
	writeSchemaCache(cacheFile, stamp, Object.fromEntries(schemas));
	return schemas.get(name) as GraphSchema;
}

/** Run the installed native CLI with JSON on stdin; cancellation stops its process tree. */
export async function runGraphCli(
	binary: string,
	name: GraphTool,
	request: unknown,
	cwd: string,
	trusted: boolean,
	signal?: AbortSignal,
): Promise<{ output: unknown; isError: boolean }> {
	signal?.throwIfAborted();
	await prepareTree();
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["--json", name, "--input", "-"], {
			cwd,
			env: environment(cwd, trusted),
			detached: process.platform !== "win32",
			stdio: "pipe",
			windowsHide: true,
		});
		adoptTree(child.pid);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			killTree(child.pid);
		};
		const abort = () => stop(new Error("Graph request cancelled"));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const timer = setTimeout(() => stop(new Error("Octocode graph CLI exceeded 120 seconds")), 120_000);
		const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 8 * 1024 * 1024) stop(new Error("Octocode graph response exceeded 8 MiB; reduce responseChars"));
			else chunks.push(chunk);
		};
		child.stdout.on("data", capture(stdout));
		child.stderr.on("data", capture(stderr));
		child.on("error", (error) => {
			failure ??= error;
		});
		child.stdin.on("error", (error) => {
			if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (failure) {
				reject(failure);
				return;
			}
			try {
				const output: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
				if (!isRecord(output)) throw new Error("Expected a JSON object");
				resolve({ output, isError: code === null || code > 1 });
			} catch {
				reject(
					new Error(
						`Octocode graph CLI returned no valid JSON (exit ${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`,
					),
				);
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}
