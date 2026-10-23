import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import nodePath from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { lsRenderers } from "./renderers/ls.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of entries to return (default: 500)" })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many sorted entries (default: 0); use the returned next offset to continue" })),
});

export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
	nextOffset?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit, offset = 0 }: { path?: string; limit?: number; offset?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
			if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("limit must be a positive integer");
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", ctx?.cwd || cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists.
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}
						if (signal?.aborted) return;

						// Check if path is a directory.
						const stat = await ops.stat(dirPath);
						if (signal?.aborted) return;
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// Read directory entries.
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e) {
							reject(new Error(`Cannot read directory: ${e instanceof Error ? e.message : String(e)}`));
							return;
						}
						if (signal?.aborted) return;

						// Sort alphabetically, case-insensitive.
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators.
						const results: string[] = [];
						const positions: number[] = [];
						let entryLimitReached = false;
						for (let index = offset; index < entries.length;) {
							if (signal?.aborted) return;
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const start = index;
							const batch = entries.slice(index, index + Math.min(32, effectiveLimit - results.length));
							const stats = await Promise.allSettled(batch.map((entry) => ops.stat(nodePath.join(dirPath, entry))));
							for (const [relative, stat] of stats.entries()) {
								if (stat.status !== "fulfilled") continue;
								results.push(batch[relative]! + (stat.value.isDirectory() ? "/" : ""));
								positions.push(start + relative);
							}
							index += batch.length;
						}

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: offset > 0 ? "(no more entries)" : "(empty directory)" }], details: undefined });
							return;
						}

						const rawOutput = results.join("\n");
						// Apply byte truncation. There is no separate line limit because entry count is already capped.
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// Build actionable notices for truncation and entry limits.
						const notices: string[] = [];
						if (entryLimitReached) {
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (entryLimitReached || truncation.truncated) {
							const shown = truncation.truncated ? truncation.outputLines : results.length;
							details.nextOffset = positions[shown - 1]! + 1;
							notices.push(`Use offset=${details.nextOffset} to continue (entries must remain unchanged)`);
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e) {
						reject(e);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
				})();
			});
		},
		...lsRenderers,
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
