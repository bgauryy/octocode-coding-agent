import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { useStore } from "zustand";
import { AgentIcon } from "../ui/icons.tsx";
import { CommandButton, ConnectionNotice } from "./controls.tsx";
import { useLive } from "./session.tsx";

/** The host resolves the item and comments when accepting the request; cards never send cached task text. */
export function ItemImplementation({ item, compact = false }: { item: SnapshotItem; compact?: boolean }) {
	const { workspace, session } = useLive();
	const available = useStore(workspace, (state) => state.snapshot !== null);
	const running = useStore(session, (state) => state.application?.streaming ?? false);
	return (
		<div className={compact ? "item-quick-action" : "item-implementation"}>
			{!compact && <ConnectionNotice />}
			<CommandButton
				label={compact ? "Implement" : "Implement item"}
				accessibleLabel={`Implement ${item.ref}`}
				action="work"
				item={item}
				icon={<AgentIcon />}
				variant="primary"
				size={compact ? "sm" : "md"}
				disabledReason={available ? "" : "Connect to a running Octocode session to implement this item."}
				showActivity
			/>
			{!compact && (
				<p className="muted">
					Sends <strong>Implement backlog item {item.ref}</strong> to the current agent with the item details and all
					comments. {running ? "It will run after the current task. " : ""}Follow progress in Activity.
				</p>
			)}
		</div>
	);
}

export function ItemQuickAction({ item }: { item: SnapshotItem }) {
	return item.state === "done" ? null : <ItemImplementation item={item} compact />;
}
