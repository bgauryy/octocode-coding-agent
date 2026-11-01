import { useStore } from "zustand";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import { AlertIcon } from "../ui/icons.tsx";
import { Button, EmptyState } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

/**
 * What a live view shows before its first session snapshot: a skeleton while the connection is still being made, and an
 * error with a way forward once it has failed, so a failure never reads as loading that will finish.
 */
export function SessionUnavailable({ hint }: { hint: string }) {
	const tone = useStore(useLive().session, (state) => state.status.tone);
	if (tone === "error")
		return (
			<EmptyState
				icon={<AlertIcon size={20} />}
				title="Can't reach the session"
				action={<Button onClick={() => location.reload()}>Reload page</Button>}
			>
				The terminal session may have ended. Run <code>/web</code> again to reopen it.
			</EmptyState>
		);
	return (
		<>
			<ListSkeleton label="Connecting to the session" />
			<p className="muted">{hint}</p>
		</>
	);
}
