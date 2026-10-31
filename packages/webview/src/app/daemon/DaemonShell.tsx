import type { DaemonRepo, DaemonSession } from "@octocodeai/octocode-contracts/daemon";
import { useEffect, useMemo, useState } from "react";
import { ConfigView } from "../config/ConfigView.tsx";
import { useHashRoute } from "../hooks.ts";
import { hashFor } from "../model/route.ts";
import { Badge, Button, cx, EmptyState, RelativeTime, Skeleton, SkeletonLine } from "../ui/primitives.tsx";
import { createDaemonApi } from "./api.ts";

const TABS = [
	{ name: "sessions", label: "Sessions" },
	{ name: "repos", label: "Backlogs" },
	{ name: "settings", label: "Settings" },
] as const;
const REFRESH_MS = 3000;

type Loaded<T> =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; value: T; at: number };

/** Polls `load` while mounted; the list is small and the daemon answers from memory. */
function usePolled<T>(load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
	const [state, setState] = useState<Loaded<T>>({ status: "loading" });
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = () =>
			load(controller.signal)
				.then(
					(value) => {
						if (!controller.signal.aborted) setState({ status: "ready", value, at: Date.now() });
					},
					(error: unknown) => {
						if (!controller.signal.aborted)
							setState({ status: "error", message: error instanceof Error ? error.message : "Request failed" });
					},
				)
				.finally(() => {
					if (!controller.signal.aborted) timer = setTimeout(run, REFRESH_MS);
				});
		void run();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [load]);
	return state;
}

function List<T>({
	state,
	count,
	empty,
	children,
}: {
	state: Loaded<T>;
	count: (value: T) => number;
	empty: string;
	children: (value: T) => React.ReactNode;
}) {
	if (state.status === "loading")
		return (
			<Skeleton label="Loading">
				<SkeletonLine width="60%" />
				<SkeletonLine width="40%" />
			</Skeleton>
		);
	if (state.status === "error")
		return (
			<p className="callout tone-danger" role="alert">
				{state.message}
			</p>
		);
	if (count(state.value) === 0) return <EmptyState title={empty} />;
	return <ul className="row-list panel daemon-list">{children(state.value)}</ul>;
}

function SessionRow({ session, now }: { session: DaemonSession; now: number }) {
	return (
		<li className={`daemon-row${session.needsYou ? " needs-you" : ""}`}>
			<div className="daemon-row-main">
				<strong>{session.repoName}</strong>{" "}
				{session.needsYou ? (
					<Badge tone="warning">Needs you</Badge>
				) : session.busy ? (
					<Badge tone="accent">Working</Badge>
				) : (
					<Badge tone="success">Live</Badge>
				)}
				{session.needsYou ? <div className="daemon-needs-you">{session.needsYou}</div> : null}
				<div className="muted daemon-path">{session.cwd}</div>
				<div className="muted">
					Started <RelativeTime at={session.startedAt} now={now} />
				</div>
			</div>
			<a className="btn" href={`/?s=${encodeURIComponent(session.id)}#activity`}>
				Open session
			</a>
		</li>
	);
}

function RepoRow({ repo }: { repo: DaemonRepo }) {
	const base = `/?r=${encodeURIComponent(repo.id)}`;
	return (
		<li className="daemon-row">
			<div className="daemon-row-main">
				<strong>{repo.name}</strong>
				{repo.sessions > 0 ? <Badge tone="success">{repo.sessions} live</Badge> : <Badge>no session</Badge>}
			</div>
			<span className="daemon-actions">
				<a className="btn" href={`${base}#board`}>
					Board
				</a>
				{repo.hasReports ? (
					<a className="btn" href={`${base}#rfc`}>
						Reports
					</a>
				) : null}
			</span>
		</li>
	);
}

/**
 * The user-level daemon's home: live sessions (each opens its own live view), the read-only backlog of every repository,
 * and the read-only Settings page. It holds no authority; sessions keep execution and permissions.
 */
export function DaemonShell({ access }: { access: string }) {
	const api = useMemo(() => createDaemonApi(access), [access]);
	const route = useHashRoute();
	const tab = TABS.find((entry) => entry.name === route.name)?.name ?? "sessions";
	const sessions = usePolled(api.sessions);
	const repos = usePolled(api.repos);
	const now = sessions.status === "ready" ? sessions.at : 0;
	return (
		<div className="shell daemon-shell">
			<header className="top">
				<div className="header-main">
					<div className="header-row">
						<div className="brand">
							<span className="brand-mark" aria-hidden="true" />
							<span>Octocode</span>
							<span className="brand-sep" aria-hidden="true">
								/
							</span>
							<span className="muted">Web workspace</span>
						</div>
					</div>
					<nav className="tabs" aria-label="Sections">
						{TABS.map(({ name, label }) => (
							<a
								key={name}
								href={hashFor(name)}
								className={cx("tab", name === tab && "active")}
								aria-current={name === tab ? "page" : undefined}
							>
								{label}
							</a>
						))}
					</nav>
				</div>
			</header>
			<main className="content daemon-content">
				{tab === "sessions" ? (
					<List
						state={sessions}
						count={(value) => value.sessions.length + (value.unavailable?.length ?? 0)}
						empty="No live sessions. Start one with OCTOCODE_WEB_DAEMON=1 and run /web."
					>
						{(value) => (
							<>
								{value.sessions.map((session) => (
									<SessionRow key={session.id} session={session} now={now} />
								))}
								{(value.unavailable ?? []).map((session) => (
									<li key={session.id} className="daemon-row">
										<div className="daemon-row-main">
											<strong>{session.repoName}</strong> <Badge tone="warning">Not connected</Badge>
											<div className="muted daemon-path">{session.cwd}</div>
											<div className="muted">{session.message}</div>
										</div>
									</li>
								))}
							</>
						)}
					</List>
				) : tab === "repos" ? (
					<List state={repos} count={(value) => value.repos.length} empty="No repositories have a backlog yet.">
						{(value) => (
							<>
								{value.repos.map((repo) => (
									<RepoRow key={repo.id} repo={repo} />
								))}
								{value.truncated ? (
									<li className="daemon-row muted">Showing the first {value.repos.length} repositories.</li>
								) : null}
							</>
						)}
					</List>
				) : (
					<ConfigView load={api.config} />
				)}
				<p className="muted daemon-note">
					<Button size="sm" onClick={() => location.reload()}>
						Refresh page
					</Button>
				</p>
			</main>
		</div>
	);
}
