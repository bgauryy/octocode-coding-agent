import { renderInstruction } from "../../core/prompt-template.ts";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { formatSize, truncateHead } from "../../core/tools/index.ts";
import type { Permission } from "../permission/ask.ts";
import { actionWhy } from "../permission/mode.ts";
import { shortPath } from "../shared/format.ts";
import { REQUEST_MAX_CHARS, RESULT_DEFAULT_BYTES } from "../../utils/output-budget.ts";
import { resultBlock, resultText, spillPath, toolHeader } from "../shared/render.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { boundImagePart, capResultText, saveFullOutput, saveImageFile } from "../shared/spill.ts";
import { capChars, textResult } from "../shared/util.ts";
import { visibleError } from "../shared/visible-error.ts";
import { imageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { type FetchedImage, pageFetcher } from "./fetch.ts";
import { classifyHost, metadataRefusal, reachesMetadata } from "../../../../common/src/web-guard.ts";
import { collapseLinkRuns } from "./html.ts";
import { savedPageLead, savedPageTools } from "./leads.ts";
import { search } from "./search.ts";
import { plural } from "../shared/render/text.ts";
import { timedTool, timingOf } from "../shared/render/rows.ts";
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
		return `Fetched ${formatSize(value.bytes)} · ${plural(value.lines, "line")}`;
	if (value.kind === "image" && typeof value.bytes === "number")
		return `Fetched ${value.mimeType ?? "image"} · ${formatSize(value.bytes)}`;
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
	const line = `${image.url}: ${image.mimeType} image, ${formatSize(image.bytes.byteLength)}. ${file ? `Original saved to ${file}.` : "The original could not be saved."}`;
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
async function approveFetch(
	permission: Permission,
	ctx: ExtensionContext,
	toolCallId: string,
	url: string,
	signal: AbortSignal | undefined,
): Promise<{ private: boolean }> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return { private: false };
	}
	// An invariant, like the state folder: `net.private` runs in `full`, and this request returns the machine's credentials.
	if (await reachesMetadata(target)) {
		const refusal = metadataRefusal(target.host);
		permission.refused([`web ${url}`], refusal, "web");
		throw new Error(refusal);
	}
	const privateHost = (await classifyHost(target)).kind === "private";
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
	return { private: privateHost };
}

export function registerWebTool(api: ExtensionAPI, permission: Permission): void {
	const fetchUrl = pageFetcher();
	api.registerTool(
		timedTool({
			name: "web",
			label: "Web",
			promptSnippet: renderInstruction("tools/web/snippet.md"),
			description:
				"Pass query to search the web or url to read one http(s) page; supply exactly one. Fetches extract static page text and metadata or format JSON; they do not run JavaScript. A PNG, JPEG, GIF or WebP URL returns the image itself (resized when large; the original is saved and named); SVG is read as its XML source. Cross-host redirects name the next URL instead of following it.",
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
						description: `Fetch preview size (default ${DEFAULT_FETCH_CHARS}, between 1,000 and ${MAX_FETCH_CHARS.toLocaleString("en-US")}); longer fetched text is saved to a file: read it by line range instead of fetching again`,
					}),
				),
			}),
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
							// Octocode tools take an absolute path; without them the short form is enough to read.
							const tools = savedPageTools(api.getActiveTools());
							const where = tools.clasify || tools.localSearch || tools.localFetch ? file : shortPath(file);
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
