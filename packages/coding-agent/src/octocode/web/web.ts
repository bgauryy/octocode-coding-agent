import { displayText, textResultDisplay } from "../render/display.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { truncateHead } from "../../core/tools/index.ts";
import { formatBytes } from "../../utils/bytes.ts";
import type { Permission } from "../permission/ask.ts";
import { actionWhy } from "../permission/mode.ts";
import { shortPath } from "../../utils/display-path.ts";
import { REQUEST_MAX_CHARS, RESULT_DEFAULT_BYTES } from "../../utils/output-budget.ts";
import { resultBlock, resultText, spillPath, toolHeader } from "../render/tool.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { boundImagePart, capResultText, saveFullOutput, saveImageFile } from "../shared/spill.ts";
import { capChars, textResult } from "../shared/util.ts";
import { visibleError } from "../shared/visible-error.ts";
import { imageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { type FetchedImage, pageFetcher, TIMEOUT_MS } from "./fetch.ts";
import { deadline } from "../../../../common/src/deadline.ts";
import {
	classifyHost,
	type HostLookup,
	lookupWithin,
	metadataRefusal,
	reachesMetadata,
} from "../../../../common/src/web-guard.ts";
import { collapseLinkRuns } from "./html.ts";
import { savedPageLead, savedPageTools } from "./leads.ts";
import { cachedSearch } from "./search-cache.ts";
import { plural } from "../shared/text.ts";
import { timedTool, timingOf } from "../render/rows.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { cutText } from "../../../../common/src/text.ts";

/** Default and largest page text a fetch returns (the shared result default and request maximum); `maxChars` picks a size in between. */
const DEFAULT_FETCH_CHARS = RESULT_DEFAULT_BYTES;
const MAX_FETCH_CHARS = REQUEST_MAX_CHARS;

/** What the result row summarizes: the page size, or the search provider and hit count. */
type WebDetails =
	| { kind: "fetch"; bytes: number; lines: number; file?: string }
	| { kind: "image"; mimeType: string; bytes: number; file?: string }
	| { kind: "notice"; reason: "redirect" | "unsupported" }
	| { kind: "search"; provider: string; results: number };

/** The `⎿` line: `Fetched 12 KB · 240 lines` or `8 results · duckduckgo`. */
export function webSummary(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const value = details as Partial<WebDetails>;
	if (value.kind === "fetch" && typeof value.bytes === "number" && typeof value.lines === "number")
		return `Fetched ${formatBytes(value.bytes, "compact")} · ${plural(value.lines, "line")}`;
	if (value.kind === "image" && typeof value.bytes === "number")
		return `Fetched ${value.mimeType ?? "image"} · ${formatBytes(value.bytes, "compact")}`;
	if (value.kind === "notice")
		return value.reason === "redirect"
			? "Not read: redirects to another host (not followed)"
			: "Not read: not a text document";
	if (value.kind === "search" && typeof value.results === "number")
		return `${value.results === 0 ? "No results" : plural(value.results, "result")} · ${value.provider ?? "search"}`;
	return undefined;
}

/**
 * A fetched image as a tool result: a line naming the URL, type, original size and the saved original, then the image
 * bounded to the model's limit (`boundImagePart`: resized with a dimension note when over budget, a file pointer when it
 * cannot be shown).
 */
async function imageResult(image: FetchedImage, model: ExtensionContext["model"]) {
	const data = Buffer.from(image.bytes).toString("base64");
	const file = saveImageFile(data, image.mimeType, "web image");
	const parts = await boundImagePart({ type: "image" as const, data, mimeType: image.mimeType }, "web image", {
		limits: imageLimits(model),
		...(file ? { savedAs: file } : {}),
	});
	const line = `${image.url}: ${image.mimeType} image, ${formatBytes(image.bytes.byteLength, "compact")}. ${file ? `Original saved to ${file}.` : "The original could not be saved."}`;
	const details: WebDetails = {
		kind: "image",
		mimeType: image.mimeType,
		bytes: image.bytes.byteLength,
		...(file ? { file } : {}),
	};
	return { content: [{ type: "text" as const, text: visibleControls(line) }, ...parts], details };
}

/**
 * The inline part of a page whose whole text is already saved: its first `max` characters, fewer when they would pass
 * the request maximum in bytes (a multi-byte page is far more bytes than characters), then the note and its `hint`. Sized here so
 * the result fits and the output cap never saves this preview to a second file next to the page's own.
 */
function savedPreview(text: string, max: number, hint: string): string {
	const head = cutText(text, max, { chars: true });
	const budget = {
		maxBytes: MAX_FETCH_CHARS + 1_200 - Buffer.byteLength(hint) - 256,
		maxLines: Number.MAX_SAFE_INTEGER,
	};
	const fitted = truncateHead(head, budget);
	const kept = fitted.truncated ? fitted.content || cutText(head, budget.maxBytes) : head;
	return capChars(text, kept.length, hint);
}

/** How to reach the rest of a page longer than `max` characters when it could not be saved to a file. */
function unsavedHint(length: number, max: number): string {
	const unsaved = "the whole page could not be saved to a file";
	if (length <= MAX_FETCH_CHARS) return `${unsaved}; call web again with maxChars ${length} for the rest`;
	const larger = max < MAX_FETCH_CHARS ? `; maxChars ${MAX_FETCH_CHARS} shows up to ${MAX_FETCH_CHARS}` : "";
	return `${unsaved}${larger}; the last ${length - MAX_FETCH_CHARS} characters are beyond web's ${MAX_FETCH_CHARS}-character limit: download the page with bash (curl -o) to read them`;
}

/**
 * Asks for the URL the agent chose: `web` for a public host (allowed per host for the session), `net.private` for a
 * private or local one (one prompt that also names the web reason). Resolves with whether the first request may reach
 * a private address; throws the refusal when the user said no or no one could be asked.
 */
export async function approveFetch(
	permission: Permission,
	ctx: ExtensionContext,
	toolCallId: string,
	url: string,
	signal: AbortSignal | undefined,
	options: { lookup?: HostLookup; timeoutMs?: number } = {},
): Promise<{ private: boolean; addresses?: string[] }> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { private: false };
	}
	// The host is resolved once for both checks, within the fetch's own time limit. The permission prompt waits on the
	// user and is outside it.
	const limitMs = options.timeoutMs ?? TIMEOUT_MS;
	const limit = deadline(limitMs, signal);
	let answer: Promise<Array<{ address: string }>> | undefined;
	const resolve = lookupWithin(options.lookup, limit.signal);
	const lookup: HostLookup = (name) => (answer ??= resolve(name));
	let metadata: boolean;
	let privateHost: boolean;
	let addresses: string[] | undefined;
	try {
		metadata = await reachesMetadata(target, lookup);
		privateHost = (await classifyHost(target, lookup)).kind === "private";
		limit.signal.throwIfAborted();
		addresses = (await answer?.catch(() => undefined))?.map(({ address }) => address);
	} catch (error) {
		if (signal?.aborted) throw signal.reason;
		if (limit.signal.aborted) throw new Error(`Timed out after ${limitMs / 1000}s fetching ${url}`, { cause: error });
		throw error;
	} finally {
		limit.clear();
	}
	// An invariant, like the state folder: `net.private` runs in `full`, and this request returns the machine's credentials.
	if (metadata) {
		const refusal = metadataRefusal(target.host);
		permission.refused([`web ${url}`], refusal, "web");
		throw new Error(refusal);
	}
	const grant = { key: target.host, label: target.host };
	const verdict = await permission.check(ctx, {
		action: privateHost ? "net.private" : "web",
		title: privateHost ? "Fetch a private address?" : "Fetch this page?",
		what: [url],
		...(privateHost ? { reason: actionWhy("web") } : {}),
		grant,
		toolCallId,
		cwd: ctx.cwd,
		...(signal ? { signal } : {}),
	});
	if (!verdict.allowed) throw new Error(verdict.message);
	return { private: privateHost, ...(addresses && { addresses }) };
}

export function registerWebTool(api: ExtensionAPI, permission: Permission): void {
	const fetchUrl = pageFetcher();
	const search = cachedSearch();
	api.registerTool(
		timedTool({
			name: "web",
			label: "Web",
			promptSnippet: renderInstruction("tools/web/snippet.md"),
			description:
				"Supply exactly one: query to search, or url to read an http(s) page. Fetches return static text and metadata or formatted JSON; no JavaScript runs. Image URLs (PNG, JPEG, GIF, WebP) return images, resizing large ones and naming saved originals; SVG returns XML. Cross-host redirects name the next URL without following it.",
			// The snippet sends GitHub and package source to the declared search and read tools; without them the research policy
			// routes those lookups here. These lines own only how to use a result (guidelines are static, so they cannot depend
			// on the selected tools).
			promptGuidelines: [],
			parameters: Type.Object({
				url: Type.Optional(Type.String({ description: "Public http(s) page to read" })),
				query: Type.Optional(Type.String({ description: "Search terms" })),
				maxResults: Type.Optional(Type.Integer({ description: "Search result limit (default 8, up to 20)" })),
				maxChars: Type.Optional(
					Type.Integer({
						description: `Fetch preview size (default ${DEFAULT_FETCH_CHARS}, between 1,000 and ${MAX_FETCH_CHARS.toLocaleString("en-US")}); longer text is saved to a file: read it by line range`,
					}),
				),
			}),
			display(input) {
				const { args } = input;
				const details = input.result?.details as WebDetails | undefined;
				const file = details?.kind === "fetch" || details?.kind === "image" ? details.file : undefined;
				return textResultDisplay(
					{
						title: "Web",
						...(args.url ? { summary: args.url } : args.query ? { summary: `search "${args.query}"` } : {}),
						kind: args.url ? "fetch" : "search",
						blocks: [],
					},
					input,
					{ summary: webSummary(details), keepBody: true, spill: file ?? spillPath(displayText(input.result)) },
				);
			},
			renderCall(args, theme, context) {
				return toolHeader(theme, context, "Web", args.url ? args.url : args.query ? `search "${args.query}"` : "");
			},
			renderResult(result, _options, theme, context) {
				const text = resultText(result);
				const details = result.details as WebDetails | undefined;
				const summary = context.isError ? text : (webSummary(details) ?? text);
				const file = details?.kind === "fetch" || details?.kind === "image" ? details.file : undefined;
				// Errors are one message: its first line is the summary, the rest the body.
				const body = context.isError ? text.split("\n").slice(1).join("\n") : text;
				return resultBlock(theme, context, {
					summary,
					body,
					spill: file ?? spillPath(text),
					...timingOf(result.details),
				});
			},
			async execute(id, params, signal, _onUpdate, ctx) {
				try {
					signal?.throwIfAborted();
					const url = params.url?.trim();
					const query = params.query?.trim();
					if (url && query) throw new Error("Provide exactly one of url or query.");
					if (url) {
						const max = Math.min(Math.max(Math.floor(params.maxChars ?? DEFAULT_FETCH_CHARS), 1_000), MAX_FETCH_CHARS);
						// Page text is untrusted: terminal escapes, bidi and invisible characters become visible escapes (nothing is dropped) before the model sees it.
						const approved = await approveFetch(permission, ctx, id, url, signal);
						const fetched = await fetchUrl(url, signal, approved);
						if (typeof fetched !== "string") {
							if ("kind" in fetched)
								return textResult<WebDetails>(visibleControls(fetched.text), {
									kind: "notice",
									reason: fetched.reason,
								});
							return await imageResult(fetched, ctx.model);
						}
						const text = visibleControls(fetched);
						const lines = text.split("\n").length;
						const size = { kind: "fetch" as const, bytes: Buffer.byteLength(text), lines };
						if (text.length <= max) return textResult<WebDetails>(capResultText(text, "web"), size);
						// A longer page is saved whole (read the rest from the file, no refetch); the inline part folds link lists
						// (sidebars, tables of contents) so content comes first.
						const file = saveFullOutput(text, "web");
						if (file) {
							// MCP research tools take an absolute path; without them the short form is enough to read.
							const tools = savedPageTools(api.getActiveTools());
							const where = tools.search.length > 0 || tools.reader ? file : shortPath(file);
							const hint = `the whole page (${lines} lines, links included) is in ${where}: ${savedPageLead(tools)}`;
							return textResult<WebDetails>(savedPreview(collapseLinkRuns(text), max, hint), { ...size, file });
						}
						// Nothing holds the rest, so nothing is folded and the note says exactly what stays out of reach.
						return textResult<WebDetails>(
							capResultText(capChars(text, max, unsavedHint(text.length, max)), "web"),
							size,
						);
					}
					if (!query) throw new Error("Provide url or query. url reads one page; query searches the web.");
					try {
						const { provider, hits, failures } = await search(
							query,
							Math.min(Math.max(Math.floor(params.maxResults ?? 8), 1), 20),
							process.env,
							signal,
						);
						const details: WebDetails = { kind: "search", provider, results: hits.length };
						// Which provider answered matters only when others failed first: results may differ in kind and quality.
						const via = failures.length > 0 ? `\n\n(via ${provider}; skipped ${failures.join("; ")})` : "";
						if (hits.length === 0)
							return textResult(
								visibleControls(
									`No results (${provider}).${failures.length > 0 ? ` (skipped ${failures.join("; ")})` : ""}`,
								),
								details,
							);
						return textResult(
							visibleControls(
								hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join("\n\n") +
									via,
							),
							details,
						);
					} catch (error) {
						throw new Error(`Search failed: ${errorMessage(error)}`, { cause: error });
					}
				} catch (error) {
					// Page text, URLs and provider answers reach the model in errors too.
					throw visibleError(error);
				}
			},
		}),
	);
}
