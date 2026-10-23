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

/**
 * Convert the sanitized fragment to React elements. The tag and attribute allowlists apply again here, so nothing the
 * sanitizer missed can reach the DOM; code blocks become components with their own controls.
 */
function toReact(nodes: NodeListOf<ChildNode> | ChildNode[], path = ""): ReactNode[] {
	const out: ReactNode[] = [];
	for (const [i, node] of [...nodes].entries()) {
		const key = `${path}${i}`;
		if (node.nodeType === Node.TEXT_NODE) {
			out.push(node.textContent);
			continue;
		}
		if (!(node instanceof Element)) continue;
		const tag = node.tagName.toLowerCase();
		if (!TAGS.has(tag)) {
			out.push(<Fragment key={key}>{toReact(node.childNodes, `${key}.`)}</Fragment>);
			continue;
		}
		const code = tag === "pre" ? node.querySelector(":scope > code") : null;
		if (code) {
			out.push(
				<CodeBlock key={key} language={codeLanguage(code)} source={code.textContent ?? ""}>
					{toReact(code.childNodes, `${key}.`)}
				</CodeBlock>,
			);
			continue;
		}
		const props: Record<string, string> = { key };
		for (const attribute of node.attributes) {
			const name = ATTRIBUTES[attribute.name];
			if (name) props[name] = attribute.value;
		}
		out.push(createElement(tag, props, ...(tag === "br" || tag === "hr" ? [] : toReact(node.childNodes, `${key}.`))));
	}
	return out;
}

/** One short line with no Markdown syntax reads the same either way, so it skips the source and copy controls. */
function isPlainLine(text: string): boolean {
	return text.length <= 200 && !/[\n*_`#[\]>|~-]/.test(text);
}

/** Rendered Markdown with a source toggle; parsing reruns only when the text changes. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const [showSource, setShowSource] = useState(false);
	const [copied, copy] = useCopy(text);
	const content = useMemo(() => {
		try {
			return toReact(sanitizeMarkdown(text).childNodes);
		} catch {
			return [text];
		}
	}, [text]);
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
