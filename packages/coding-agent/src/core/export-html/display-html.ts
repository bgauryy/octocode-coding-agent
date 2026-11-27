import {
	knownToolDisplayBlock,
	type Tone,
	type ToolDisplay,
	type ToolDisplayBlock,
} from "@octocodeai/octocode-contracts";

/** Lines a collapsed text or output block keeps; the expanded view shows all of them. */
const PREVIEW_LINES = 8;

const MARK: Record<string, string> = { done: "✓", failed: "✗", stopped: "◼", waiting: "◇", running: "…", pending: "○" };

function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const tone = (value: Tone | undefined) => (value && value !== "normal" ? ` td-${value}` : "");

function lines(text: string, collapsed: boolean, tail: boolean): string {
	const all = text.replace(/\n$/, "").split("\n");
	if (!collapsed || all.length <= PREVIEW_LINES) return escape(all.join("\n"));
	const kept = tail ? all.slice(-PREVIEW_LINES) : all.slice(0, PREVIEW_LINES);
	const more = `<span class="td-muted">… ${all.length - PREVIEW_LINES} more lines</span>`;
	return tail ? `${more}\n${escape(kept.join("\n"))}` : `${escape(kept.join("\n"))}\n${more}`;
}

function diffHtml(patch: string): string {
	let inHunk = false;
	return patch
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => {
			let kind = "";
			if (line.startsWith("@@")) {
				inHunk = true;
				kind = "td-muted";
			} else if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) kind = "td-muted";
			else if (line.startsWith("+")) kind = "td-add";
			else if (line.startsWith("-")) kind = "td-del";
			return kind ? `<span class="${kind}">${escape(line)}</span>` : escape(line);
		})
		.join("\n");
}

function blockHtml(block: ToolDisplayBlock, collapsed: boolean): string {
	const known = knownToolDisplayBlock(block);
	switch (known?.type) {
		case "text":
			return `<pre class="td-text${tone(known.tone)}">${lines(known.text, collapsed, known.preview === "tail")}</pre>`;
		case "output":
			return `<pre class="td-text">${lines(known.text, collapsed, true)}</pre>`;
		case "diff":
			return known.files
				.map(
					(file) =>
						`<div class="td-file">${escape(`${file.operation} ${file.from ? `${file.from} → ` : ""}${file.path}`)} <span class="td-add">+${file.additions}</span> <span class="td-del">-${file.removals}</span></div>${collapsed ? "" : `<pre class="td-text">${diffHtml(file.patch)}</pre>`}`,
				)
				.join("");
		case "list":
			return `<ul class="td-list">${known.items
				.map(
					(item) =>
						`<li class="${tone(item.tone).trim()}">${item.state ? `${MARK[item.state] ?? ""} ` : ""}${escape(item.text)}${item.detail ? `<div class="td-muted">${escape(item.detail)}</div>` : ""}</li>`,
				)
				.join("")}</ul>`;
		case "fields":
			return `<dl class="td-fields">${known.entries.map((entry) => `<dt>${escape(entry.label)}</dt><dd>${escape(entry.value)}</dd>`).join("")}</dl>`;
		case "markdown":
			return `<pre class="td-text">${lines(known.text, collapsed, false)}</pre>`;
		case "path":
			return collapsed ? "" : `<div class="td-muted">${escape(known.label)}: ${escape(known.path)}</div>`;
		default:
			return `<pre class="td-text">${escape(block.text)}</pre>`;
	}
}

/** The header of a call: `Title(summary) · meta`, its sub-lines and its reason. */
export function displayCallHtml(display: ToolDisplay): string {
	const meta = display.meta?.length ? `<span class="td-muted"> · ${escape(display.meta.join(" · "))}</span>` : "";
	const summary = display.summary
		? `<span class="td-muted">(</span>${escape(display.summary)}<span class="td-muted">)</span>`
		: "";
	const subjects = (display.subjects ?? []).map((line) => `<div class="td-sub">${escape(line)}</div>`).join("");
	const reason = display.reason ? `<div class="tool-reason">↳ ${escape(display.reason)}</div>` : "";
	return `<div class="td-head"><strong class="td-title">${escape(display.title)}</strong>${summary}${meta}</div>${subjects}${reason}`;
}

/** The result: the `⎿` outcome and the blocks, collapsed (previews) and expanded (everything, the prompt first). */
export function displayResultHtml(display: ToolDisplay): { collapsed: string; expanded: string } {
	const outcome = display.outcome
		? `<div class="td-outcome${display.outcome.stopped ? " td-warning" : tone(display.outcome.tone)}">⎿ ${escape(display.outcome.text)}</div>`
		: "";
	const body = (blocks: readonly ToolDisplayBlock[], collapsed: boolean) =>
		blocks.map((block) => blockHtml(block, collapsed)).join("");
	return {
		collapsed: `${outcome}${body(display.blocks, true)}`,
		expanded: `${outcome}${body([...(display.preface ?? []), ...display.blocks], false)}`,
	};
}
