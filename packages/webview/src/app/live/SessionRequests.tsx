import type { ApplicationReceipt } from "@octocodeai/octocode-contacts";
import { useStore } from "zustand";
import { Badge, Button } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { useLive } from "./session.tsx";

export function SessionRequests({ sessionId, receipts }: { sessionId: string; receipts: ApplicationReceipt[] }) {
	const { workspace } = useLive();
	const drafts = useStore(workspace, (state) => state.drafts);
	const draftKey = `session-command:${sessionId}`;
	const hasDraft = Boolean(drafts[draftKey]?.text.trim() || drafts[draftKey]?.attachments?.length);
	if (!receipts.length) return null;
	return (
		<ul className="receipts" aria-label="Recent session requests" aria-live="polite">
			{receipts
				.slice(-3)
				.reverse()
				.map((receipt) => {
					const sent = drafts[`session-sent:${sessionId}:${receipt.id}`];
					const label =
						receipt.status === "accepted"
							? "Received"
							: receipt.status === "failed"
								? "Failed"
								: sent?.to === "steer"
									? "Guidance queued"
									: sent?.to === "followUp"
										? "Follow-up queued"
										: "Handled";
					return (
						<li key={receipt.id}>
							<Badge
								tone={receipt.status === "failed" ? "danger" : "neutral"}
								icon={
									receipt.status === "failed" ? (
										<StateMark state="failed" size={12} />
									) : receipt.status === "accepted" ? (
										<StateMark state="pending" size={12} />
									) : undefined
								}
							>
								{label}
							</Badge>
							{sent?.text && (
								<span title={sent.text}>
									{sent.text.slice(0, 160)}
									{sent.text.length > 160 ? "…" : ""}
								</span>
							)}
							{receipt.message && <span>{receipt.message}</span>}
							{receipt.status === "failed" && sent && (
								<Button
									size="sm"
									disabled={hasDraft}
									title={hasDraft ? "Send or clear your current draft first." : undefined}
									onClick={() => {
										if (workspace.getState().snapshot?.sessionId !== sessionId) return;
										workspace.getState().setDraft(draftKey, { ...sent, id: crypto.randomUUID() });
									}}
								>
									Restore message
								</Button>
							)}
						</li>
					);
				})}
		</ul>
	);
}
