import { parseApplicationTool, resultPurposeData } from "@octocodeai/octocode-contracts";
import type {
	ApplicationAsset,
	ApplicationContentBlock,
	ApplicationTool,
	ContentAnnotation,
} from "@octocodeai/octocode-contracts";
import { memo, useEffect, useState } from "react";
import { safeWebLink } from "../../link.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { toolState } from "@octocodeai/octocode-projections";
import { TextFold } from "../ui/LongText.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { type AssetLoader, AssetExpansionButton, useAssetExpansion, useAssetRead } from "./asset-expansion.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolDisplayView } from "./ToolDisplayView.tsx";
import { RawToolData, ToolReason } from "./ToolRawData.tsx";
import { ToolProgress } from "./ToolProgress.tsx";
import { ToolPurposes } from "./ToolPurposes.tsx";

interface ContentProps {
	content: readonly ApplicationContentBlock[];
	tools?: readonly ApplicationTool[];
	loadAsset: AssetLoader;
	plain?: boolean;
	streaming?: boolean;
	/** Rewrites a text block's Markdown for display (backlog IDs with titles); the content itself is unchanged. */
	decorate?: (markdown: string) => string;
	ancestors?: readonly string[];
}

/** Ordered shared blocks, with a visible fallback for every supported content kind. */
export const ContentBlocks = memo(function ContentBlocks({
	content,
	tools = [],
	loadAsset,
	plain,
	streaming,
	decorate,
	ancestors = [],
}: ContentProps) {
	return (
		<div className="content-blocks">
			{content.map((block) => {
				switch (block.type) {
					case "text":
						return (
							<div key={block.id}>
								<ExpandedText
									text={block.text}
									full={block.full}
									loadAsset={loadAsset}
									plain={plain}
									streaming={streaming}
									decorate={decorate}
								/>
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
	streaming,
	decorate,
}: {
	text: string;
	full?: ApplicationAsset;
	loadAsset: AssetLoader;
	plain?: boolean;
	streaming?: boolean;
	decorate?: (markdown: string) => string;
}) {
	const read = useAssetRead<string>(full);
	const value = read.loaded?.value ?? text;
	const body = plain ? <pre className="text output">{value}</pre> : <Markdown text={value} decorate={decorate} />;
	return (
		<>
			{value &&
				(streaming ? (
					body
				) : (
					<TextFold
						key={read.loaded?.key ?? "preview"}
						text={value}
						label={plain ? "Output" : "Message"}
						initiallyOpen={!!read.loaded}
					>
						{body}
					</TextFold>
				))}
			<AssetExpansionButton
				label="Load full content"
				expansion={{
					available: !!full,
					value: read.loaded?.value,
					loading: read.loading,
					error: read.error,
					load: () => read.run(async (asset) => (await loadAsset(asset.id)).text()),
				}}
			/>
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
					const href = annotation.url && safeWebLink(annotation.url);
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
	const href = uri && safeWebLink(uri);
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

const PREVIEW_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
/** Types the page previews; a browser shows them as media, never as a document. */
const previewable = (mimeType: string) =>
	PREVIEW_IMAGE.test(mimeType) || mimeType.startsWith("audio/") || mimeType.startsWith("video/");

/**
 * Never embed provider URLs; authenticated session bytes become short-lived local object URLs. An object URL has the
 * page's origin, so any other type (HTML, SVG, XML) is downloaded as opaque bytes: a download link opened in a tab
 * must not run the asset's script with the page's origin and storage.
 */
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
					url = URL.createObjectURL(
						previewable(asset.mimeType) ? blob : new Blob([blob], { type: "application/octet-stream" }),
					);
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
	}, [asset.id, asset.mimeType, assetKey, loadAsset]);
	const current = state?.id === assetKey ? state : undefined;
	const url = current?.url;
	const label = asset.name ?? (image ? "Image attachment" : asset.mimeType);
	const imageMime = PREVIEW_IMAGE.test(asset.mimeType);
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
	// The host decides the reason line and how the call reads, the same for every surface.
	const display = tool?.display;
	const reason = display?.reason ?? "";
	const media = tool?.content?.filter((block) => block.type !== "text" && block.type !== "thinking");
	return (
		<section
			className={`content-tool${tool?.status === "failed" && !tool.notRun ? " is-failed" : ""}`}
			aria-label={`Tool ${name}`}
		>
			<header>
				<strong>
					{display?.title ?? name}
					{display?.summary && <span className="tool-summary">({display.summary})</span>}
				</strong>
				<span>
					<StateMark state={toolState(tool)} size={12} /> {tool?.notRun ? "not run" : (tool?.status ?? "Preparing")}
					{display?.meta?.length ? ` · ${display.meta.join(" · ")}` : ""}
					{tool?.durationMs === undefined ? "" : ` · ${Math.round(tool.durationMs)} ms`}
				</span>
			</header>
			<ToolReason reason={reason} />
			{tool?.status === "running" && tool.progress && <ToolProgress progress={tool.progress} />}
			{display ? (
				<>
					<ToolDisplayView display={display} />
					{media?.length ? (
						<ContentBlocks content={media} tools={tools} loadAsset={loadAsset} ancestors={path} />
					) : null}
				</>
			) : tool?.content ? (
				<ContentBlocks
					content={tool.content}
					tools={tools}
					loadAsset={loadAsset}
					plain={name !== "agent"}
					ancestors={path}
				/>
			) : (
				tool?.text && <ExpandedText text={tool.text} loadAsset={loadAsset} plain />
			)}
			<ToolPurposes structuredContent={resultPurposeData(tool)} shown={reason} />
			<RawToolData tool={tool} args={args} />
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
