import fs from "node:fs";
import { applyEditsToNormalizedContent, normalizeToLF } from "../../../core/tools/edit-diff.ts";
import { splitBom } from "../../../utils/text.ts";
import type { ExtensionToolContext } from "../../../core/extensions/index.ts";
import type { Permission } from "../../permission/ask.ts";
import { runsLater, stateFolderRefusal } from "../../permission/file-access.ts";
import { sha256 } from "../../../utils/atomic-file.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../../shared/home/repo.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { transformPatch, type ParsedPatch } from "../../shared/codex-patch/patch.ts";
import { type FileGuard, judgeChange, lostAnchor, staleRefusal } from "./guard.ts";
import { copiedElision, type FileQuery, type PreparedChange } from "./queries.ts";
import { resolveAnchoredEdits } from "./anchored.ts";
import { workspaceRefusal } from "./run.ts";

/** Checks a whole batch before any of it is applied: a Codex patch's operations, or a batch of queries under review. */

export async function preparePatch(
	patch: ParsedPatch,
	reason: string,
	guard: FileGuard,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	permission: Permission,
	id: string,
): Promise<PreparedChange[]> {
	const prepared: PreparedChange[] = [];
	const seen = new Set<string>();
	const destinations = new Set<string>();
	for (const hunk of patch.hunks) {
		const source = canonicalPath(resolveToolPath(ctx.cwd, hunk.path));
		if (seen.has(source)) throw new Error(`Duplicate patch operations target the same path: ${hunk.path}`);
		seen.add(source);
		const targets = new Set([
			source,
			...(hunk.kind === "update" && hunk.move_path !== null
				? [canonicalPath(resolveToolPath(ctx.cwd, hunk.move_path))]
				: []),
		]);
		if ([...targets].some((target) => destinations.has(target)))
			throw new Error("Overlapping patch operation targets require a sequential patch adapter; no changes applied");
		for (const target of targets) destinations.add(target);
	}
	seen.clear();
	const inspect = async (query: FileQuery, mode = query.type) => {
		signal?.throwIfAborted();
		const file = resolveToolPath(ctx.cwd, query.path);
		const outside = await workspaceRefusal(file, query, ctx, signal, permission, id);
		if (outside) throw new Error(outside);
		const check = guard.inspect(file, mode, query.path);
		if (check.refusal) throw new Error(check.refusal);
		const data = check.current ? await fs.promises.readFile(file) : undefined;
		const digest = data ? sha256(data) : null;
		const judged = judgeChange(query.path, mode, check, data, digest, guard.reader);
		if (judged.refusal) throw new Error(judged.refusal);
		const copied = copiedElision(query, data?.toString("utf8") ?? "");
		if (copied)
			throw new Error(
				`The new text contains "${copied}": an output-cut placeholder, not file content. Re-read the source and write the full text.`,
			);
		return { data, digest, changed: judged.changed };
	};
	for (const hunk of patch.hunks) {
		const source = resolveToolPath(ctx.cwd, hunk.path);
		const key = canonicalPath(source);
		if (seen.has(key)) throw new Error(`Duplicate patch operations target the same path: ${hunk.path}`);
		seen.add(key);
		if (hunk.kind === "add") {
			const query: FileQuery = {
				type: "write",
				path: hunk.path,
				content: hunk.content,
				reason,
			};
			const checked = await inspect(query);
			prepared.push({ query, mode: "write", digest: checked.digest });
		} else if (hunk.kind === "delete") {
			const query: FileQuery = { type: "delete", path: hunk.path, reason };
			const checked = await inspect(query);
			if (!checked.data) throw new Error(`Cannot delete missing file ${hunk.path}`);
			prepared.push({ query, mode: "delete", digest: checked.digest });
		} else {
			const edits = hunk.chunks
				.filter((c) => c.old.length)
				.map((c) => ({ oldText: c.old.join("\n"), newText: c.new.join("\n") }));
			const query: FileQuery = {
				type: "edit",
				path: hunk.path,
				edits,
				reason,
			};
			const checked = await inspect(query);
			if (!checked.data) throw new Error(`Cannot update missing file ${hunk.path}`);
			if (checked.changed) {
				const lost = lostAnchor(hunk.path, edits, checked.data.toString("utf8"), guard.reader);
				if (lost || !edits.length) throw new Error(lost ?? staleRefusal(hunk.path, guard.reader));
			}
			const content = transformPatch(checked.data.toString("utf8"), hunk.chunks);
			if (hunk.move_path !== null) {
				const destination: FileQuery = {
					type: "write",
					path: hunk.move_path,
					content,
					reason,
				};
				const target = await inspect(destination);
				const samePath = canonicalPath(resolveToolPath(ctx.cwd, hunk.move_path)) === key;
				// A move removes the source, so require the source deletion guard too.
				await inspect({ type: "delete", path: hunk.path, reason });
				prepared.push(
					{ query: destination, mode: "write", digest: target.digest },
					{
						query: { type: "delete", path: hunk.path, reason },
						mode: "delete",
						// A same-path Move writes first, then deletes those newly written bytes.
						digest: samePath ? sha256(content) : checked.digest,
					},
				);
			} else
				prepared.push({
					query: { type: "write", path: hunk.path, content, reason },
					mode: "edit",
					digest: checked.digest,
				});
		}
	}
	return prepared;
}

export async function inspectQueryBatch(
	queries: FileQuery[],
	guard: FileGuard,
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
	rejectOverlap = false,
) {
	const targets = new Set<string>();
	const prepared: PreparedChange[] = [];
	let outside = false;
	for (const query of queries) {
		signal?.throwIfAborted();
		const file = resolveToolPath(ctx.cwd, query.path);
		const real = canonicalPath(file);
		const repeated = targets.has(real);
		if (rejectOverlap && repeated)
			throw new Error("Overlapping rewritten file targets require sequential preparation; no changes applied");
		targets.add(real);
		const state = stateFolderRefusal(real, query.path, "the file tool");
		if (state) throw new Error(state);
		const root = workspaceRoot(ctx.cwd);
		outside ||= !root || !isWithin(real, root) || runsLater(real, root);
		if (query.type === "edit" && !query.edits?.length) throw new Error("edit needs a non-empty edits array.");
		if (query.type === "write" && query.content === undefined) throw new Error("write needs content.");
		if (repeated) {
			const reserved = guard.reservedBy?.(file);
			if (reserved) throw new Error(reserved);
			// Unchanged native batches still evaluate later same-file queries after earlier mutations.
			prepared.push({
				query,
				mode: query.type,
				digest: null,
				canonicalPath: real,
			});
			continue;
		}
		const inspection = guard.inspect(file, query.type, query.path);
		if (inspection.refusal) throw new Error(inspection.refusal);
		const data = inspection.current ? await fs.promises.readFile(file) : undefined;
		signal?.throwIfAborted();
		const digest = data ? sha256(data) : null;
		const judged = judgeChange(query.path, query.type, inspection, data, digest, guard.reader);
		if (judged.refusal) throw new Error(judged.refusal);
		if (query.type === "edit") {
			const resolved = data ? resolveAnchoredEdits(query, data, guard, file) : query;
			if (judged.changed) {
				const lost = lostAnchor(query.path, resolved.edits ?? [], data?.toString("utf8") ?? "", guard.reader);
				if (lost) throw new Error(lost);
			}
			const content = splitBom(data?.toString("utf8") ?? "").text;
			applyEditsToNormalizedContent(normalizeToLF(content), resolved.edits ?? [], query.path);
		}
		const copied = copiedElision(query, data?.toString("utf8") ?? "");
		if (copied) throw new Error(`The new text contains "${copied}": an output-cut placeholder, not file content.`);
		prepared.push({ query, mode: query.type, digest, canonicalPath: real });
	}
	return { prepared, outside };
}
