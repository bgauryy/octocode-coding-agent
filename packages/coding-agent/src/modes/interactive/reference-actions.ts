import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import {
	markdownCodeBlocks,
	markdownPlainText,
	markdownReferences,
	type MarkdownReference,
} from "@octocodeai/octocode-tui";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { openBrowser } from "../../../../common/src/open-browser.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openItemLink } from "../../octocode/shared/item-ref.ts";
import { locationText, openReference, referenceLocation, type ReferenceHost } from "./reference-opener.ts";
import { chooseReference, type ReferencePickerHost } from "./reference-picker.ts";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";

interface ActionHost extends ReferenceHost, ReferencePickerHost {
	session: { getLastAssistantText(): string | undefined; readonly messages: AgentMessage[] };
	sessionManager: { getCwd(): string };
}

async function copy(host: ActionHost, text: string, label: string): Promise<void> {
	try {
		await copyToClipboard(text);
		host.showStatus(`Copied ${label}`);
	} catch (error) {
		host.showError(`${errorMessage(error)}. ${label} remains available in the transcript.`);
	}
}

async function selectReference(
	host: ActionHost,
	references: MarkdownReference[],
	query = "",
): Promise<MarkdownReference | undefined> {
	const needle = query.toLowerCase();
	const filtered = references.filter((ref) => `${ref.label} ${ref.url}`.toLowerCase().includes(needle));
	if (!filtered.length) {
		host.showWarning("No matching references in this scope. Use /links all to search this session.");
		return undefined;
	}
	const labels = filtered.map(
		(ref, i) => `${i + 1}. ${sanitizeTerminalText(ref.label)} — ${sanitizeTerminalText(ref.url)}`,
	);
	const selected = await chooseReference(host, "References — type to filter, Enter to choose", labels);
	return selected ? filtered[labels.indexOf(selected)] : undefined;
}

export async function handleLinksCommand(host: ActionHost, args: string): Promise<void> {
	const all = /^all(?:\s|$)/.test(args);
	const chooseMessage = /^message(?:\s|$)/.test(args);
	const query = all || chooseMessage ? args.replace(/^(?:all|message)\s*/, "") : args;
	const cwd = host.sessionManager.getCwd();
	let sources = [host.session.getLastAssistantText() ?? ""];
	if (all || chooseMessage) {
		sources = host.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) =>
				message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n\n"),
			);
		if (chooseMessage) {
			if (!sources.length) {
				host.showWarning("No agent messages with references yet.");
				return;
			}
			const labels = sources
				.map((text, index) => `${index + 1}. ${sanitizeTerminalText(text.replace(/\s+/g, " ").slice(0, 120))}`)
				.reverse();
			const selected = await chooseReference(host, "Choose an answer — newest first", labels);
			if (!selected) return;
			sources = [sources[sources.length - 1 - labels.indexOf(selected)]];
		}
	}
	const references = new Map<string, MarkdownReference>();
	for (const [index, source] of sources.entries()) {
		for (const ref of markdownReferences(source, cwd)) references.set(`${ref.label}\0${ref.url}`, ref);
		if (index % 32 === 31) await setImmediate();
	}
	const reference = await selectReference(host, [...references.values()], query);
	if (!reference) return;
	const location = referenceLocation(reference.url);
	const actions = [
		"Open",
		"Inspect destination",
		"Copy destination",
		"Copy Markdown link",
		...(location ? ["Copy location", "Copy path", "Reveal parent folder"] : []),
	];
	const action = await chooseReference(host, sanitizeTerminalText(reference.label), actions);
	if (action === "Open")
		openItemLink(reference.url, (target) => {
			void openReference(host, target);
		});
	else if (action === "Inspect destination") host.showStatus(sanitizeTerminalText(reference.url));
	else if (action === "Copy destination") await copy(host, reference.url, "destination");
	else if (action === "Copy Markdown link")
		await copy(
			host,
			`[${reference.label.replace(/[\\[\]]/g, "\\$&")}](${reference.url.replaceAll("(", "%28").replaceAll(")", "%29")})`,
			"Markdown link",
		);
	else if (action === "Copy location" && location) await copy(host, locationText(location), "file location");
	else if (action === "Copy path" && location) await copy(host, location.path, "file path");
	else if (action === "Reveal parent folder" && location) openBrowser(pathToFileURL(dirname(location.path)).href);
}

export async function handleSemanticCopy(host: ActionHost, mode: string): Promise<void> {
	const source = host.session.getLastAssistantText();
	if (!source) {
		host.showWarning("No agent messages to copy yet.");
		return;
	}
	if (mode === "markdown") return copy(host, source, "Markdown");
	if (mode === "message" || mode === "references")
		return copy(host, markdownPlainText(source, mode === "references", host.sessionManager.getCwd()), "message");
	if (mode === "location") {
		const reference = await selectReference(
			host,
			markdownReferences(source, host.sessionManager.getCwd()).filter((ref) => ref.url.startsWith("file:")),
		);
		const location = reference && referenceLocation(reference.url);
		if (location) await copy(host, locationText(location), "file location");
		return;
	}
	if (mode === "code") {
		const blocks = markdownCodeBlocks(source);
		if (!blocks.length) {
			host.showWarning("No fenced code blocks in the last answer.");
			return;
		}
		let block = blocks[0];
		if (blocks.length > 1) {
			const labels = blocks.map(
				(item, i) => `${i + 1}. ${item.language} — ${sanitizeTerminalText(item.text.split("\n")[0])}`,
			);
			const choice = await chooseReference(host, "Copy code block", labels);
			if (!choice) return;
			block = blocks[labels.indexOf(choice)];
		}
		if (block) await copy(host, block.text, "code");
		return;
	}
	host.showWarning("Usage: /copy [message|markdown|references|code|location]");
}
