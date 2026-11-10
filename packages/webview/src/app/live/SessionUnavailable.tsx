import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import { AlertIcon } from "../ui/icons.tsx";
import { Button, EmptyState } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

/** How long "Connecting…" may last before the view says there is no session. */
const CONNECT_WAIT_MS = 5000;

function useWaited(ms: number): boolean {
	const [waited, setWaited] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setWaited(true), ms);
		return () => clearTimeout(timer);
	}, [ms]);
	return waited;
}

/**
 * What a live view shows before its first session snapshot: a skeleton while the connection is still being made, and an
 * error with a way forward once it has failed, so a failure never reads as loading that will finish.
 */
export function SessionUnavailable({ hint, label = "Connecting to the session" }: { hint: string; label?: string }) {
	const waited = useWaited(CONNECT_WAIT_MS);
	const tone = useStore(useLive().session, (state) => state.status.tone);
	if (tone === "error")
		return (
			<EmptyState
				icon={<AlertIcon size={20} />}
				title="Can't reach the session"
				action={<Button onClick={() => location.reload()}>Reload page</Button>}
			>
				The terminal session may have ended, or this link is missing or has expired. Run <code>/web</code> again to
				reopen it.
			</EmptyState>
		);
	if (waited)
		return (
			<EmptyState icon={<AlertIcon size={20} />} title="No session">
				{hint} This page keeps trying to connect and updates by itself once a session answers.
			</EmptyState>
		);
	return (
		<>
			<ListSkeleton label={label} />
			<p className="muted">{hint}</p>
		</>
	);
}
