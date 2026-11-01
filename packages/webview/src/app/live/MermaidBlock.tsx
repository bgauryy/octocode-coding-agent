import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { sanitizeSvg } from "../../svg.ts";
import { useCopy } from "../hooks.ts";
import { diagramLabel, mermaidTheme } from "../model/docs.ts";
import { CheckIcon, CodeIcon, CopyIcon } from "../ui/icons.tsx";
import { Button } from "../ui/primitives.tsx";
import { loadMermaid } from "./mermaid-loader.ts";
import { useLive } from "./session.tsx";

type Render = { status: "loading" } | { status: "ready"; svg: string } | { status: "failed"; message: string };

function firstLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.split("\n").find((line) => line.trim()) ?? "Unknown error";
}

/**
 * One ```mermaid block: a diagram rendered by the lazily loaded, locally bundled Mermaid, with its diagram type, a source
 * toggle and copy. When the diagram cannot be drawn, the source stays readable with the parse error beside it.
 */
export function MermaidBlock({ source }: { source: string }) {
	const { api } = useLive();
	const id = `mmd-${useId().replace(/[^\w-]/g, "")}`;
	const [render, setRender] = useState<Render>({ status: "loading" });
	const [showSource, setShowSource] = useState(false);
	const [copied, copy] = useCopy(source);
	const canvas = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const mermaid = await loadMermaid(() => api.mermaidScript());
				const style = getComputedStyle(document.documentElement);
				const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
				mermaid.initialize({
					startOnLoad: false,
					suppressErrorRendering: true,
					securityLevel: "strict",
					theme: "base",
					fontFamily: style.getPropertyValue("--font").trim() || "system-ui, sans-serif",
					themeVariables: mermaidTheme((name) => style.getPropertyValue(name).trim(), dark),
				});
				const { svg } = await mermaid.render(id, source);
				if (!cancelled) setRender({ status: "ready", svg });
			} catch (error) {
				if (!cancelled) setRender({ status: "failed", message: firstLine(error) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [api, id, source]);
	useLayoutEffect(() => {
		const element = canvas.current;
		if (!element || render.status !== "ready") return;
		element.replaceChildren(sanitizeSvg(render.svg));
	}, [render]);
	const failed = render.status === "failed";
	const sourceShown = failed || showSource;
	return (
		<figure className="diagram" data-render={render.status}>
			<div className="diagram-toolbar">
				<span className="code-language">{diagramLabel(source)}</span>
				{render.status === "ready" ? (
					<Button
						size="sm"
						variant="ghost"
						icon={<CodeIcon />}
						aria-pressed={showSource}
						onClick={() => setShowSource((value) => !value)}
					>
						{showSource ? "Show diagram" : "Show source"}
					</Button>
				) : null}
				<Button size="sm" variant="ghost" icon={copied === "copied" ? <CheckIcon /> : <CopyIcon />} onClick={copy}>
					{copied === "copied" ? "Copied" : copied === "failed" ? "Copy unavailable — select the text" : "Copy source"}
				</Button>
			</div>
			{render.status === "loading" ? <output className="muted">Rendering diagram…</output> : null}
			{failed ? (
				<p className="diagram-error" role="alert">
					Could not draw this diagram, so its source is shown. {render.message}
				</p>
			) : null}
			<div className="diagram-canvas" ref={canvas} hidden={sourceShown || render.status !== "ready"} />
			<pre className="diagram-source" hidden={!sourceShown}>
				{source}
			</pre>
		</figure>
	);
}
