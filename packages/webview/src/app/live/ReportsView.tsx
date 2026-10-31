import type { ReportFile, ReportSummary } from "@octocodeai/octocode-contracts/protocol";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import type { ViewProps } from "../extension.ts";
import { errorMessage, plural } from "../model/format.ts";
import { KIND_LABELS, TAB_KINDS, type ReportTab } from "../model/reports.ts";
import { RichTextContext } from "../ui/LongText.tsx";
import { Badge, Button, EmptyState } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

interface ListState {
	reports: ReportSummary[];
	loading: boolean;
	error: string;
}
const FIRST_LIST: ListState = { reports: [], loading: true, error: "" };

type DocumentState = { file: string; markdown: string } | { file: string; error: string };

/** Saved RFCs of this workspace, read from `.octocode/` by the authenticated host. */
export function RfcView(props: ViewProps) {
	return <ReportsTab {...props} tab="rfc" heading="RFCs" empty="No RFCs saved in this workspace yet." />;
}

/** Saved research briefs and brainstorms of this workspace. */
export function ResearchView(props: ViewProps) {
	return (
		<ReportsTab
			{...props}
			tab="research"
			heading="Research"
			empty="No research briefs or brainstorms saved in this workspace yet."
		/>
	);
}

function ReportsTab({
	tab,
	heading,
	empty,
	params,
	setParams,
}: ViewProps & { tab: ReportTab; heading: string; empty: string }) {
	const { api } = useLive();
	const [list, setList] = useState<ListState>(FIRST_LIST);
	const load = useCallback(
		(signal: AbortSignal) =>
			api.reports(signal).then(
				(reports) => {
					if (signal.aborted) return;
					setList({ reports: reports.reports, loading: false, error: "" });
				},
				(error: unknown) => {
					if (signal.aborted) return;
					setList((current) => ({ reports: current.reports, loading: false, error: errorMessage(error) }));
				},
			),
		[api],
	);
	const controllerRef = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		controllerRef.current = controller;
		void load(controller.signal);
		return () => {
			controller.abort();
			controllerRef.current = null;
		};
	}, [load]);
	const retry = () => {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		setList((current) => ({ reports: current.reports, loading: true, error: "" }));
		void load(controller.signal);
	};
	const reports = useMemo(
		() => list.reports.filter((report) => TAB_KINDS[tab].includes(report.kind)),
		[list.reports, tab],
	);
	const selected = params.id
		? reports.find((report) => report.id === params.id && (!params.kind || report.kind === params.kind))
		: undefined;
	const file =
		selected && params.file && selected.files.some((entry) => entry.name === params.file)
			? params.file
			: selected?.files[0]?.name;
	if (selected)
		return (
			// Remounting on kind, id and file keeps the document state with the document it belongs to.
			<ReportDocument
				key={`${selected.kind}:${selected.id}:${file ?? ""}`}
				report={selected}
				file={file}
				onNavigate={(next) =>
					setParams(
						next ? { id: selected.id, kind: selected.kind, file: next } : { id: selected.id, kind: selected.kind },
					)
				}
				onBack={() => setParams({})}
			/>
		);
	return (
		<div className="view reports-view">
			<header className="view-head">
				<h2>{heading}</h2>
				<p className="muted">Saved documents of this workspace; the newest come first.</p>
			</header>
			{list.loading && !reports.length ? (
				<ListSkeleton label="Loading reports" rows={4} />
			) : !reports.length && !list.error ? (
				<EmptyState title={empty} />
			) : (
				<>
					{list.error ? <div role="alert">{list.error}</div> : null}
					<ul className="plain-list report-list">
						{reports.map((report) => (
							<ReportRow
								key={`${report.kind}:${report.id}`}
								report={report}
								tab={tab}
								onOpen={() => setParams({ id: report.id, kind: report.kind })}
							/>
						))}
					</ul>
					{list.error ? <Button onClick={retry}>Retry loading reports</Button> : null}
				</>
			)}
		</div>
	);
}

function ReportRow({ report, tab, onOpen }: { report: ReportSummary; tab: ReportTab; onOpen: () => void }) {
	return (
		<li>
			<a
				href={`#${tab}?id=${encodeURIComponent(report.id)}`}
				onClick={(event) => {
					event.preventDefault();
					onOpen();
				}}
			>
				<strong>{report.title}</strong>
				<Badge tone={report.status === "Accepted" ? "success" : "accent"}>
					{report.status ?? KIND_LABELS[report.kind]}
				</Badge>
			</a>
			{report.question ? <p className="muted">{report.question}</p> : null}
			<p className="muted">
				{report.updated.slice(0, 10)} · {plural(report.files.length, "document")}
			</p>
		</li>
	);
}

function ReportDocument({
	report,
	file,
	onNavigate,
	onBack,
}: {
	report: ReportSummary;
	file: string | undefined;
	onNavigate: (file?: string) => void;
	onBack: () => void;
}) {
	const { api } = useLive();
	const RichText = useContext(RichTextContext);
	const [document, setDocument] = useState<DocumentState | undefined>();
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (!file) return;
		const controller = new AbortController();
		let cancelled = false;
		api
			.reportFile(report.id, report.kind, file, controller.signal)
			.then(
				(value: ReportFile) => {
					if (!cancelled) setDocument({ file, markdown: value.markdown });
				},
				(error: unknown) => {
					if (!cancelled) setDocument({ file, error: errorMessage(error) });
				},
			)
			.catch(() => undefined);
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [api, report.id, report.kind, file, attempt]);
	const retry = () => {
		setDocument(undefined);
		setAttempt((count) => count + 1);
	};
	return (
		<div className="view reports-view">
			<header className="view-head">
				<p>
					<a
						href={`#${report.kind === "rfc" ? "rfc" : "research"}`}
						onClick={(event) => {
							event.preventDefault();
							onBack();
						}}
					>
						Back to all {report.kind === "rfc" ? "RFCs" : "research"}
					</a>
				</p>
				<h2>{report.title}</h2>
				<p>
					<Badge>{KIND_LABELS[report.kind]}</Badge>
					{report.status ? (
						<Badge tone={report.status === "Accepted" ? "success" : "accent"}>{report.status}</Badge>
					) : null}
					{report.confidence ? <Badge>{`confidence ${report.confidence}`}</Badge> : null}
					{file ? (
						<span className="muted">
							{file} · {report.updated.slice(0, 10)}
						</span>
					) : null}
				</p>
				{report.question ? <p className="muted">{report.question}</p> : null}
			</header>
			{report.files.length > 1 ? (
				<nav className="report-files" aria-label="Report documents">
					{report.files.map((entry) => (
						<Button key={entry.name} onClick={() => onNavigate(entry.name)} disabled={!file || entry.name === file}>
							{entry.name}
						</Button>
					))}
				</nav>
			) : null}
			{!file ? (
				<EmptyState title="This report has no readable documents." />
			) : !document ? (
				<ListSkeleton label={`Loading ${file}`} rows={6} />
			) : "error" in document ? (
				<>
					<div role="alert">{document.error}</div>
					<Button onClick={retry}>Retry loading the document</Button>
				</>
			) : (
				<div className="report-body">
					{/* oxlint-disable-next-line react/static-components -- the context supplies one module-level renderer; nothing is created during render. */}
					{RichText ? <RichText text={document.markdown} /> : <pre className="text">{document.markdown}</pre>}
				</div>
			)}
		</div>
	);
}
