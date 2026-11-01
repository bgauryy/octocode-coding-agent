import { createElement, Fragment, memo, type ReactNode, useMemo, useState } from "react";
import { codeLanguage, MARKDOWN_TAGS, sanitizeMarkdown } from "../../markdown.ts";
import { useCopy } from "../hooks.ts";
import { CheckIcon, CodeIcon, CopyIcon, WrapIcon } from "../ui/icons.tsx";
import { Button, cx } from "../ui/primitives.tsx";

const TAGS = new Set<string>(MARKDOWN_TAGS);
const ATTRIBUTES: Record<string, string> = {
	href: "href",
	title: "title",
	class: "className",
	start: "start",
	target: "target",
	rel: "rel",
};

/** How a reader of whole documents extends the renderer: fenced blocks of a language and plain text can be replaced. */
export interface MarkdownHooks {
	/** A node for a fenced block of `language`, or undefined to keep the ordinary code block. */
	code?: (language: string, source: string, key: string) => ReactNode | undefined;
	/** The nodes shown for text outside code and links. */
	text?: (text: string) => ReactNode;
}

/**
 * Convert the sanitized fragment to React elements. The tag and attribute allowlists apply again here, so nothing the
 * sanitizer missed can reach the DOM; code blocks become components with their own controls.
 */
function toReact(
	nodes: NodeListOf<ChildNode> | ChildNode[],
	path = "",
	hooks?: MarkdownHooks,
	literal = false,
): ReactNode[] {
	const out: ReactNode[] = [];
	for (const [i, node] of [...nodes].entries()) {
		const key = `${path}${i}`;
		if (node.nodeType === Node.TEXT_NODE) {
			out.push(
				hooks?.text && !literal ? (
					<Fragment key={key}>{hooks.text(node.textContent ?? "")}</Fragment>
				) : (
					node.textContent
				),
			);
			continue;
		}
		if (!(node instanceof Element)) continue;
		const tag = node.tagName.toLowerCase();
		if (!TAGS.has(tag)) {
			out.push(<Fragment key={key}>{toReact(node.childNodes, `${key}.`, hooks, literal)}</Fragment>);
			continue;
		}
		const code = tag === "pre" ? node.querySelector(":scope > code") : null;
		if (code) {
			const language = codeLanguage(code);
			const custom = language ? hooks?.code?.(language, code.textContent ?? "", key) : undefined;
			if (custom !== undefined) {
				out.push(custom);
				continue;
			}
			out.push(
				<CodeBlock key={key} language={codeLanguage(code)} source={code.textContent ?? ""}>
					{toReact(code.childNodes, `${key}.`, undefined, true)}
				</CodeBlock>,
			);
			continue;
		}
		const props: Record<string, string> = { key };
		for (const attribute of node.attributes) {
			const name = ATTRIBUTES[attribute.name];
			if (name) props[name] = attribute.value;
		}
		const inner = literal || tag === "a" || tag === "code";
		out.push(
			createElement(
				tag,
				props,
				...(tag === "br" || tag === "hr" ? [] : toReact(node.childNodes, `${key}.`, hooks, inner)),
			),
		);
	}
	return out;
}

/** Sanitized Markdown as React elements; the text is shown as plain text when it cannot be parsed. */
export function renderMarkdown(text: string, hooks?: MarkdownHooks): ReactNode[] {
	try {
		return toReact(sanitizeMarkdown(text).childNodes, "", hooks);
	} catch {
		return [text];
	}
}

/** One short line with no Markdown syntax reads the same either way, so it skips the source and copy controls. */
function isPlainLine(text: string): boolean {
	return text.length <= 200 && !/[\n*_`#[\]>|~-]/.test(text);
}

/** Rendered Markdown with a source toggle; parsing reruns only when the text changes. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const [showSource, setShowSource] = useState(false);
	const [copied, copy] = useCopy(text);
	const content = useMemo(() => renderMarkdown(text), [text]);
	if (isPlainLine(text))
		return (
			<div className="markdown-view">
				<div className="markdown-body">{content}</div>
			</div>
		);
	return (
		<div className="markdown-view">
			<div className="markdown-toolbar">
				<Button
					size="sm"
					variant="ghost"
					icon={<CodeIcon />}
					aria-pressed={showSource}
					onClick={() => setShowSource((value) => !value)}
				>
					{showSource ? "View Markdown" : "View source"}
				</Button>
				<Button size="sm" variant="ghost" icon={copied === "copied" ? <CheckIcon /> : <CopyIcon />} onClick={copy}>
					{copied === "copied"
						? "Copied"
						: copied === "failed"
							? "Copy unavailable — select the text"
							: "Copy Markdown"}
				</Button>
			</div>
			<div className="markdown-body" hidden={showSource}>
				{content}
			</div>
			<pre className="markdown-source" hidden={!showSource}>
				{text}
			</pre>
		</div>
	);
});

function CodeBlock({ language, source, children }: { language?: string; source: string; children: ReactNode }) {
	const [wrap, setWrap] = useState(false);
	const [copied, copy] = useCopy(source);
	const lines = source.trimEnd().split("\n").length;
	return (
		<div className="code-view">
			<div className="code-toolbar">
				<span className="code-language">
					{language ?? "text"} · {lines} {lines === 1 ? "line" : "lines"}
				</span>
				<Button
					size="sm"
					variant="ghost"
					icon={<WrapIcon />}
					aria-pressed={wrap}
					onClick={() => setWrap((value) => !value)}
				>
					Wrap code
				</Button>
				<Button size="sm" variant="ghost" icon={copied === "copied" ? <CheckIcon /> : <CopyIcon />} onClick={copy}>
					{copied === "copied" ? "Copied" : copied === "failed" ? "Copy unavailable — select the text" : "Copy code"}
				</Button>
			</div>
			<pre className={cx(wrap && "wrap-code")}>
				<code className={language ? `language-${language}` : undefined}>{children}</code>
			</pre>
		</div>
	);
}
