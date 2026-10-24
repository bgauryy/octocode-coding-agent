import { parseApplicationMessage, type ApplicationMessage } from "@octocodeai/octocode-contacts";
import { memo, useCallback } from "react";
import { stamp } from "../model/format.ts";
import { LongText } from "../ui/LongText.tsx";
import { Badge, type BadgeTone, cx } from "../ui/primitives.tsx";
import { AssetExpansionButton, useAssetExpansion } from "./asset-expansion.tsx";
import { ContentBlocks, JsonDetails, ToolContent } from "./ContentBlocks.tsx";
import { DiffView } from "./DiffView.tsx";
import { activityCard, type FeedEvent, fileDiffs, type Tone } from "./model.ts";
import { Elapsed, ThoughtFor } from "./RunIndicator.tsx";
import { useLive } from "./session.tsx";
import { SessionActivityContent } from "./SessionActivityContent.tsx";

const BADGE_TONES: Record<Tone, BadgeTone> = {
	success: "success",
	danger: "danger",
	tool: "tool",
	agent: "agent",
	neutral: "neutral",
};

/** Memoized on the event object; the interner keeps unchanged events identical, so only changed rows render. */
export const ResultCard = memo(function ResultCard({ event, compact }: { event: FeedEvent; compact?: boolean }) {
	const { api } = useLive();
	const loadAsset = useCallback(
		(id: string, signal?: AbortSignal) => {
			if (!event.sessionId) return Promise.reject(new Error("This content has no session reference."));
			return api.asset(event.sessionId, id, signal);
		},
		[api, event.sessionId],
	);
	const expansion = useAssetExpansion<ApplicationMessage>(event.message?.full, loadAsset, (value, previous) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid full message content");
		if ("id" in value && value.id !== event.message?.id) throw new Error("Invalid full message content");
		const result = parseApplicationMessage({
			...(previous ?? event.message),
			...value,
			id: event.message?.id,
			role: event.message?.role,
			complete: event.message?.complete,
			...(event.message?.status === undefined ? {} : { status: event.message.status }),
			...(event.message?.display === undefined ? {} : { display: event.message.display }),
			full: "full" in value ? value.full : undefined,
		});
		if (!result) throw new Error("Invalid full message content");
		return result;
	});
	const message = expansion.value ?? event.message;
	const card = activityCard({ ...event, message });
	const diffs = event.type === "tool.result" ? fileDiffs(event.tool?.details ?? event.details) : [];
	const streaming = card.status === "streaming";
	return (
		<article className={cx("result-card", `tone-${card.tone}`, compact && "is-compact", streaming && "is-streaming")}>
			<div className="result-meta">
				<Badge tone={BADGE_TONES[card.tone]}>{card.label}</Badge>
				{card.status === "running" && event.type.startsWith("tool.") ? (
					<span className="muted">
						<Elapsed since={event.at} prefix="running · " />
					</span>
				) : (
					card.status && <span className={cx("muted", streaming && "streaming-label")}>{card.status}</span>
				)}
				{card.thoughtMs !== undefined && <ThoughtFor ms={card.thoughtMs} />}
				<time dateTime={new Date(event.at).toISOString()}>{stamp(event.at)}</time>
			</div>
			<h3>{card.title}</h3>
			{card.goal && <p className="muted">{card.goal}</p>}
			{event.type === "application.error" ? (
				<p role="alert">{card.body}</p>
			) : event.activity ? (
				<SessionActivityContent activity={event.activity} text={card.body} loadAsset={loadAsset} />
			) : message?.content ? (
				<ContentBlocks content={message.content} tools={event.tools} loadAsset={loadAsset} />
			) : event.tool ? (
				<ToolContent
					tool={event.tool}
					name={event.tool.toolName}
					toolCallId={event.tool.toolCallId}
					tools={event.tools}
					loadAsset={loadAsset}
				/>
			) : (
				card.body && <LongText text={card.body} label="output" plain={!card.markdown} />
			)}
			<AssetExpansionButton expansion={expansion} label="Load full message" />
			{message?.errorMessage && <p role="alert">{message.errorMessage}</p>}
			{message && (
				<div className="message-metadata">
					{message.model && <span>{[message.provider, message.model].filter(Boolean).join(" / ")}</span>}
					{message.durationMs !== undefined && <span>{Math.round(message.durationMs)} ms</span>}
					{message.stopReason && <span>Finish: {message.stopReason}</span>}
				</div>
			)}
			{message?.usage && <JsonDetails label="Usage" value={message.usage} />}
			{message?.details !== undefined && <JsonDetails label="Details" value={message.details} />}
			{diffs.length > 0 && <DiffView diffs={diffs} />}
			{card.files.length > 0 && (
				<div className="result-files">
					<strong>Related files</strong>
					<ul>
						{card.files.map((file) => (
							<li key={file}>
								<code>{file}</code>
							</li>
						))}
					</ul>
				</div>
			)}
			{event.details !== undefined && !message && !event.tool && !event.activity && (
				<details className="result-details">
					<summary>Structured details</summary>
					<pre>{JSON.stringify(event.details, null, 2)}</pre>
				</details>
			)}
		</article>
	);
});
