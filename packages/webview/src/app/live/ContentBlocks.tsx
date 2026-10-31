import { parseApplicationTool } from "@octocodeai/octocode-contracts";
import type {
	ApplicationAsset,
	ApplicationContentBlock,
	ApplicationTool,
	ContentAnnotation,
} from "@octocodeai/octocode-contracts";
import { memo, useEffect, useState } from "react";
import { safeMarkdownLink } from "../../markdown.ts";
import { errorMessage } from "../model/format.ts";
import { toolState } from "../model/ui-state.ts";
import { Button } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { AssetExpansionButton, useAssetExpansion } from "./asset-expansion.tsx";
import { Markdown } from "./Markdown.tsx";

export type AssetLoader = (id: string, signal?: AbortSignal) => Promise<Blob>;
interface ContentProps {
	content: readonly ApplicationContentBlock[];
	tools?: readonly ApplicationTool[];
	loadAsset: AssetLoader;
	plain?: boolean;
	ancestors?: readonly string[];
}

/** Ordered shared blocks, with a visible fallback for every supported content kind. */
export const ContentBlocks = memo(function ContentBlocks({
	content,
	tools = [],
	loadAsset,
	plain,
	ancestors = [],
}: ContentProps) {
	return (
		<div className="content-blocks">
			{content.map((block) => {
				switch (block.type) {
					case "text":
						return (
							<div key={block.id}>
								<ExpandedText text={block.text} full={block.full} loadAsset={loadAsset} plain={plain} />
								<Citations annotations={block.annotations} />
							</div>
						);
					case "thinking":
						return (
							<details key={block.id} className="reasoning-block">
								<summary>{block.redacted ? "Reasoning unavailable" : "Reasoning"}</summary>
								{!block.redacted && <ExpandedText text={block.text} full={block.full} loadAsset={loadAsset} />}
							</details>
						);
					case "image":
						return <AssetPreview key={block.id} asset={block.asset} loadAsset={loadAsset} image />;
					case "media":
						return block.asset ? (
							<AssetPreview key={block.id} asset={block.asset} loadAsset={loadAsset} />
						) : (
							<Resource key={block.id} uri={block.uri} name={block.name ?? block.mimeType} />
						);
					case "resource":
						return (
							<div key={block.id} className="resource-block">
								<Resource uri={block.uri} name={block.name ?? block.uri} />
								{(block.text || block.full) && (
									<ExpandedText text={block.text ?? ""} full={block.full} loadAsset={loadAsset} plain />
								)}
							</div>
						);
					case "toolCall":
						return (
							<ToolContent
								key={block.id}
								tool={tools.find((tool) => tool.toolCallId === block.toolCallId)}
								name={block.name}
								args={block.arguments}
								toolCallId={block.toolCallId}
								tools={tools}
								loadAsset={loadAsset}
								ancestors={ancestors}
							/>
						);
					case "unsupported":
						return (
							<div key={block.id} className="unsupported-block">
								<p className="muted">Content type: {block.providerType}</p>
								<ExpandedText
									text={block.text || "This content has no preview."}
									full={block.full}
									loadAsset={loadAsset}
									plain
								/>
							</div>
						);
				}
			})}
		</div>
	);
});

export function ExpandedText({
	text,
	full,
	loadAsset,
	plain,
}: {
	text: string;
	full?: ApplicationAsset;
	loadAsset: AssetLoader;
	plain?: boolean;
}) {
	const [expanded, setExpanded] = useState<{ id: string; text: string }>();
	const fullKey = full && `${full.id}:${full.revision ?? ""}`;
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const value = full && expanded && expanded.id === fullKey ? expanded.text : text;
	return (
		<>
			{value && (plain ? <pre className="text output">{value}</pre> : <Markdown text={value} />)}
			{full && expanded?.id !== fullKey && (
				<Button
					size="sm"
					loading={loading}
					onClick={async () => {
						setLoading(true);
						setError("");
						try {
							setExpanded({ id: fullKey!, text: await (await loadAsset(full.id)).text() });
						} catch (cause) {
							setError(errorMessage(cause));
						} finally {
							setLoading(false);
						}
					}}
				>
					Load full content
				</Button>
			)}
			{error && <p role="alert">{error}</p>}
		</>
	);
}

function Citations({ annotations }: { annotations?: readonly ContentAnnotation[] }) {
	if (!annotations?.length) return null;
	return (
		<ol className="content-citations" aria-label="Sources">
			{[...new Map(annotations.map((annotation) => [JSON.stringify(annotation), annotation])).entries()].map(
				([key, annotation], index) => {
					const label =
						annotation.title ?? annotation.text ?? annotation.url ?? annotation.fileId ?? `Source ${index + 1}`;
					const href = annotation.url && safeMarkdownLink(annotation.url);
					return (
						<li key={key}>
							{href ? (
								<a href={href} target="_blank" rel="noopener noreferrer">
									{label}
								</a>
							) : (
								label
							)}
							{annotation.startPage !== undefined && <span> · page {annotation.startPage}</span>}
						</li>
					);
				},
			)}
		</ol>
	);
}

function Resource({ uri, name }: { uri?: string; name: string }) {
	const href = uri && safeMarkdownLink(uri);
	return (
		<p className="resource-reference">
			{href ? (
				<a href={href} target="_blank" rel="noopener noreferrer">
					{name}
				</a>
			) : (
				<span>
					{name}
					{uri && uri !== name ? ` (${uri})` : ""}
				</span>
			)}
		</p>
	);
}

/** Never embed provider URLs; authenticated session bytes become short-lived local object URLs. */
function AssetPreview({
	asset,
	loadAsset,
	image,
}: {
	asset: ApplicationAsset;
	loadAsset: AssetLoader;
	image?: boolean;
}) {
	const assetKey = `${asset.id}:${asset.revision ?? ""}`;
	const [state, setState] = useState<{ id: string; url?: string; error?: string }>();
	const [failedPreview, setFailedPreview] = useState<string>();
	const previewFailed = failedPreview === assetKey;
	useEffect(() => {
		const controller = new AbortController();
		let url: string | undefined;
		void loadAsset(asset.id, controller.signal)
			.then(
				(blob) => {
					if (controller.signal.aborted) return;
					url = URL.createObjectURL(blob);
					setState({ id: assetKey, url });
				},
				(cause: unknown) => {
					if (!controller.signal.aborted) setState({ id: assetKey, error: errorMessage(cause) });
				},
			)
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setState({ id: assetKey, error: errorMessage(cause) });
			});
		return () => {
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [asset.id, assetKey, loadAsset]);
	const current = state?.id === assetKey ? state : undefined;
	const url = current?.url;
	const label = asset.name ?? (image ? "Image attachment" : asset.mimeType);
	const imageMime = /^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mimeType);
	return (
		<figure className="content-asset">
			{!current && <p className="muted">Loading {label}…</p>}
			{current?.error && (
				<p role="alert">
					{label}: {current.error}
				</p>
			)}
			{url &&
				!previewFailed &&
				(imageMime ? (
					<img src={url} alt={label} loading="lazy" onError={() => setFailedPreview(assetKey)} />
				) : asset.mimeType.startsWith("audio/") ? (
					// oxlint-disable-next-line jsx-a11y/media-has-caption -- Provider audio assets may have no caption track; the original remains downloadable.
					<audio src={url} controls preload="metadata" onError={() => setFailedPreview(assetKey)} />
				) : asset.mimeType.startsWith("video/") ? (
					// oxlint-disable-next-line jsx-a11y/media-has-caption -- Provider video assets may have no caption track; the original remains downloadable.
					<video src={url} controls preload="metadata" onError={() => setFailedPreview(assetKey)} />
				) : null)}
			{previewFailed && <p className="muted">Preview unavailable. Download the attachment to view it.</p>}
			<figcaption>
				{url ? (
					<a href={url} download={asset.name ?? "attachment"}>
						Download {label}
					</a>
				) : (
					label
				)}{" "}
				· {asset.mimeType} · {asset.size.toLocaleString()} bytes
			</figcaption>
		</figure>
	);
}

export function ToolContent({
	tool: source,
	name,
	args,
	toolCallId,
	tools = [],
	loadAsset,
	ancestors = [],
}: {
	tool?: ApplicationTool;
	name: string;
	args?: unknown;
	toolCallId: string;
	tools?: readonly ApplicationTool[];
	loadAsset: AssetLoader;
	ancestors?: readonly string[];
}) {
	const expansion = useAssetExpansion<ApplicationTool>(source?.full, loadAsset, (value, previous) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid full tool content");
		if ("toolCallId" in value && value.toolCallId !== toolCallId) throw new Error("Invalid full tool content");
		const result = parseApplicationTool({
			...(previous ?? source),
			...value,
			toolCallId,
			toolName: source?.toolName ?? name,
			status: source?.status,
			...(source?.arguments === undefined ? {} : { arguments: source.arguments }),
			full: "full" in value ? value.full : undefined,
		});
		if (!result) throw new Error("Invalid full tool content");
		return result;
	});
	const tool = expansion.value ?? source;
	if (ancestors.includes(toolCallId)) return <p className="muted">Nested tool reference: {name}</p>;
	const path = [...ancestors, toolCallId];
	const nested = tools.filter((item) => item.parentToolCallId === toolCallId);
	return (
		<section
			className={`content-tool${tool?.status === "failed" && !tool.notRun ? " is-failed" : ""}`}
			aria-label={`Tool ${name}`}
		>
			<header>
				<strong>{name}</strong>
				<span>
					<StateMark state={toolState(tool)} size={12} /> {tool?.notRun ? "not run" : (tool?.status ?? "Preparing")}
					{tool?.durationMs === undefined ? "" : ` · ${Math.round(tool.durationMs)} ms`}
				</span>
			</header>
			<ToolReason args={tool?.arguments ?? args} />
			{(tool?.arguments ?? args) !== undefined && <JsonDetails label="Arguments" value={tool?.arguments ?? args} />}
			{tool?.content ? (
				<ContentBlocks
					content={tool.content}
					tools={tools}
					loadAsset={loadAsset}
					plain={name !== "agent"}
					ancestors={path}
				/>
			) : (
				tool?.text && <pre className="text output">{tool.text}</pre>
			)}
			{tool?.structuredContent !== undefined && (
				<JsonDetails label="Structured result" value={tool.structuredContent} />
			)}
			{tool?.details !== undefined && <JsonDetails label="Result details" value={tool.details} />}
			{tool?.usage !== undefined && <JsonDetails label="Tool usage" value={tool.usage} />}
			<AssetExpansionButton expansion={expansion} label="Load full tool result" />
			{nested.map((child) => (
				<ToolContent
					key={child.toolCallId}
					tool={child}
					name={child.toolName}
					toolCallId={child.toolCallId}
					tools={tools}
					loadAsset={loadAsset}
					ancestors={path}
				/>
			))}
		</section>
	);
}

/**
 * The call's `reason` (every native tool requires one; models add it to MCP calls) as one line under the tool's name,
 * like the terminal's `↳` row. A one-word reason (`Edit`) says no more than the name.
 */
function ToolReason({ args }: { args: unknown }) {
	const reason =
		args && typeof args === "object" && "reason" in args && typeof args.reason === "string"
			? args.reason.replace(/\s+/g, " ").trim()
			: "";
	return reason.includes(" ") ? <p className="tool-reason">↳ {reason}</p> : null;
}

export function JsonDetails({ label, value }: { label: string; value: unknown }) {
	return (
		<details className="result-details">
			<summary>{label}</summary>
			<pre>{JSON.stringify(value, null, 2)}</pre>
		</details>
	);
}
