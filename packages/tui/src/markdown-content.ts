import { Marked, type Token, type Tokens } from "marked";
import { fileReferenceUrl, findFileReferences } from "./components/markdown/linkify.ts";

export interface MarkdownReference {
	label: string;
	url: string;
}

const parser = new Marked();
const controls = /[\x00-\x1f\x7f-\x9f]/u;

/** A link's full destination; relative files retain the directory that produced the message. */
export function markdownReferenceUrl(target: string, cwd: string): string | undefined {
	if (!target || controls.test(target) || target.startsWith("#")) return undefined;
	const [reference] = findFileReferences(target);
	if (reference?.start === 0 && reference.end === target.length) {
		return fileReferenceUrl(reference.path, cwd, reference.line, reference.column);
	}
	if (/^[A-Za-z][\w+.-]*:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) {
		return URL.canParse(target) ? new URL(target).href : undefined;
	}
	const hashAt = target.indexOf("#");
	const path = hashAt < 0 ? target : target.slice(0, hashAt);
	try {
		const url = new URL(fileReferenceUrl(decodeURIComponent(path), cwd));
		if (hashAt >= 0) url.hash = target.slice(hashAt);
		return url.href;
	} catch {
		return undefined;
	}
}

function children(token: Token): Token[] {
	if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens;
	if (token.type === "list") return (token as Tokens.List).items.flatMap((item) => item.tokens);
	if (token.type === "table") {
		const table = token as Tokens.Table;
		return [...table.header, ...table.rows.flat()].flatMap((cell) => cell.tokens);
	}
	return [];
}

/** Source-level references remain available without OSC 8, a mouse, or a terminal emulator. */
export function markdownReferences(source: string, cwd: string): MarkdownReference[] {
	const result: MarkdownReference[] = [];
	const seen = new Set<string>();
	const add = (label: string, url: string | undefined) => {
		if (!url || seen.has(`${label}\0${url}`)) return;
		seen.add(`${label}\0${url}`);
		result.push({ label, url });
	};
	const visit = (tokens: Token[]) => {
		for (const token of tokens) {
			if (token.type === "code" || token.type === "html") continue;
			if (token.type === "link" || token.type === "image") {
				const link = token as Tokens.Link;
				add(link.text, markdownReferenceUrl(link.href, cwd));
				continue;
			}
			const nested = children(token);
			if (nested.length) visit(nested);
			else if ("text" in token && typeof token.text === "string") {
				for (const ref of findFileReferences(token.text)) {
					add(token.text.slice(ref.start, ref.end), fileReferenceUrl(ref.path, cwd, ref.line, ref.column));
				}
			}
		}
	};
	visit(parser.lexer(source));
	return result;
}

export function markdownCodeBlocks(source: string): Array<{ language: string; text: string }> {
	const blocks: Array<{ language: string; text: string }> = [];
	const visit = (tokens: Token[]) => {
		for (const token of tokens) {
			if (token.type === "code")
				blocks.push({ language: (token as Tokens.Code).lang ?? "text", text: (token as Tokens.Code).text });
			else visit(children(token));
		}
	};
	visit(parser.lexer(source));
	return blocks;
}

/** Copy semantic content rather than borders, ANSI sequences, or wrapped terminal rows. */
export function markdownPlainText(source: string, includeTargets = false, cwd?: string): string {
	const render = (tokens: Token[]): string =>
		tokens
			.map((token): string => {
				if (token.type === "space") return "";
				if (token.type === "br") return "\n";
				if (token.type === "hr") return "\n";
				if (token.type === "html") return token.raw;
				if (token.type === "code") return `${(token as Tokens.Code).text}\n\n`;
				if (token.type === "list")
					return (
						(token as Tokens.List).items
							.map(
								(item, index) =>
									`${(token as Tokens.List).ordered ? `${Number((token as Tokens.List).start) + index}.` : "-"} ${render(item.tokens).trim()}`,
							)
							.join("\n") + "\n\n"
					);
				if (token.type === "table") {
					const table = token as Tokens.Table;
					return (
						[table.header, ...table.rows].map((row) => row.map((cell) => render(cell.tokens)).join(" | ")).join("\n") +
						"\n\n"
					);
				}
				const nested = children(token);
				const text = nested.length
					? render(nested)
					: "text" in token && typeof token.text === "string"
						? token.text
						: token.raw;
				if (token.type === "link" || token.type === "image") {
					const raw = (token as Tokens.Link).href;
					const href = cwd ? (markdownReferenceUrl(raw, cwd) ?? raw) : raw;
					return includeTargets && text !== href ? `${text} (${href})` : text;
				}
				return ["heading", "paragraph", "blockquote"].includes(token.type) ? `${text}\n\n` : text;
			})
			.join("");
	return render(parser.lexer(source)).trim();
}
