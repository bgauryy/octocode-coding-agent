import { DOC_KINDS, type DocsIndex, type DocSummary } from "@octocodeai/octocode-contracts/docs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import type { ViewProps } from "../extension.ts";
import { plural } from "../model/format.ts";
import { DOC_KIND_LABELS, filterDocs, groupDocs } from "../model/docs.ts";
import { hashFor } from "../model/route.ts";
import { Badge, Button, EmptyState } from "../ui/primitives.tsx";
import { DocBody } from "./DocBody.tsx";
import { useLive } from "./session.tsx";

interface ListState {
	index: DocsIndex | undefined;
	loading: boolean;
	error: string;
}
type DocumentState = { path: string; markdown: string } | { path: string; error: string };

/** Every Markdown document under this workspace's `.octocode/`, read by the authenticated host. */
export function DocsView({ params, setParams, index }: ViewProps) {
	const { api } = useLive();
	const includeTmp = params.tmp === "1";
	const [list, setList] = useState<ListState>({ index: undefined, loading: true, error: "" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		api.docs(includeTmp, controller.signal).then(
			(value) => {
				if (!controller.signal.aborted) setList({ index: value, loading: false, error: "" });
			},
			(error: unknown) => {
				if (!controller.signal.aborted)
					setList((current) => ({ index: current.index, loading: false, error: errorMessage(error) }));
			},
		);
		return () => controller.abort();
	}, [api, includeTmp, attempt]);
	const retry = () => {
		setList((current) => ({ ...current, loading: true, error: "" }));
		setAttempt((count) => count + 1);
	};
	const docs = list.index?.docs;
	const selected = params.path && docs ? docs.find((doc) => doc.path === params.path) : undefined;
	if (params.path && !docs && list.loading) return <ListSkeleton label="Loading documents" rows={6} />;
	if (params.path)
		return (
			<DocumentPage
				key={`${params.path}:${includeTmp}`}
				path={params.path}
				doc={selected}
				includeTmp={includeTmp}
				index={index}
				onBack={() => setParams({ ...params, path: "" })}
			/>
		);
	return (
		<DocsList
			list={list}
			kind={params.kind ?? ""}
			query={params.q ?? ""}
			includeTmp={includeTmp}
			setParams={setParams}
			params={params}
			onRetry={retry}
		/>
	);
}

function DocsList({
	list,
	kind,
	query,
	includeTmp,
	params,
	setParams,
	onRetry,
}: {
	list: ListState;
	kind: string;
	query: string;
	includeTmp: boolean;
	params: ViewProps["params"];
	setParams: ViewProps["setParams"];
	onRetry: () => void;
}) {
	const shown = useMemo(() => filterDocs(list.index?.docs ?? [], kind, query), [list.index, kind, query]);
	const groups = useMemo(() => groupDocs(shown), [shown]);
	return (
		<div className="view docs-view">
			<header className="view-head">
				<h2>Docs</h2>
				<p className="muted">Every Markdown document under .octocode/, grouped by kind and folder, newest first.</p>
			</header>
			<search className="docs-filters">
				<input
					type="search"
					aria-label="Filter documents by title, path or status"
					placeholder="Filter by title, path or status"
					value={query}
					onChange={(event) => setParams({ ...params, q: event.target.value })}
				/>
				<select aria-label="Kind" value={kind} onChange={(event) => setParams({ ...params, kind: event.target.value })}>
					<option value="">All kinds</option>
					{DOC_KINDS.map((value) => (
						<option key={value} value={value}>
							{DOC_KIND_LABELS[value]}
						</option>
					))}
				</select>
				<label>
					<input
						type="checkbox"
						checked={includeTmp}
						onChange={(event) => setParams({ ...params, tmp: event.target.checked ? "1" : "" })}
					/>{" "}
					Include tmp/
				</label>
			</search>
			{list.error ? <div role="alert">{list.error}</div> : null}
			{list.loading && !list.index ? (
				<ListSkeleton label="Loading documents" rows={6} />
			) : !shown.length && !list.error ? (
				<EmptyState
					title={list.index?.docs.length ? "No document matches these filters." : "No documents under .octocode/ yet."}
				/>
			) : (
				groups.map((group) => (
					<section key={group.kind} aria-label={DOC_KIND_LABELS[group.kind]}>
						<h3>{DOC_KIND_LABELS[group.kind]}</h3>
						{group.topics.map(({ topic, docs }) => (
							<div key={topic} className="docs-topic">
								{topic ? <h4 className="muted">{topic}/</h4> : null}
								<ul className="plain-list report-list">
									{docs.map((doc) => (
										<DocRow key={doc.path} doc={doc} params={params} />
									))}
								</ul>
							</div>
						))}
					</section>
				))
			)}
			{list.index?.truncated ? (
				<p className="muted">More documents exist than this list carries; narrow it with the filters.</p>
			) : null}
			{list.error ? <Button onClick={onRetry}>Retry loading documents</Button> : null}
		</div>
	);
}

function DocRow({ doc, params }: { doc: DocSummary; params: ViewProps["params"] }) {
	return (
		<li>
			<a href={hashFor("docs", { ...params, path: doc.path })}>
				<strong>{doc.title}</strong>
				{doc.status ? <Badge tone={doc.status === "Accepted" ? "success" : "accent"}>{doc.status}</Badge> : null}
			</a>
			{doc.question ? <p className="muted">{doc.question}</p> : null}
			<p className="muted">
				{doc.updated.slice(0, 10)} · {doc.path} · {plural(doc.bytes, "byte")}
			</p>
		</li>
	);
}

function DocumentPage({
	path,
	doc,
	includeTmp,
	index,
	onBack,
}: {
	path: string;
	doc: DocSummary | undefined;
	includeTmp: boolean;
	index: ViewProps["index"];
	onBack: () => void;
}) {
	const { api } = useLive();
	const [document, setDocument] = useState<DocumentState | undefined>();
	const [attempt, setAttempt] = useState(0);
	const retryRef = useRef(0);
	useEffect(() => {
		const controller = new AbortController();
		api.docFile(path, includeTmp, controller.signal).then(
			(value) => {
				if (!controller.signal.aborted) setDocument({ path, markdown: value.markdown });
			},
			(error: unknown) => {
				if (!controller.signal.aborted) setDocument({ path, error: errorMessage(error) });
			},
		);
		return () => controller.abort();
	}, [api, path, includeTmp, attempt]);
	const retry = useCallback(() => {
		setDocument(undefined);
		setAttempt(++retryRef.current);
	}, []);
	return (
		<div className="view docs-view">
			<header className="view-head">
				<p>
					<a
						href="#docs"
						onClick={(event) => {
							event.preventDefault();
							onBack();
						}}
					>
						Back to all docs
					</a>
				</p>
				<h2>{doc?.title ?? path}</h2>
				<p>
					{doc ? <Badge>{DOC_KIND_LABELS[doc.kind]}</Badge> : null}
					{doc?.status ? <Badge tone="accent">{doc.status}</Badge> : null}
					<span className="muted">
						{path}
						{doc ? ` · ${doc.updated.slice(0, 10)}` : ""}
					</span>
				</p>
				{doc?.question ? <p className="muted">{doc.question}</p> : null}
			</header>
			{!document ? (
				<ListSkeleton label={`Loading ${path}`} rows={6} />
			) : "error" in document ? (
				<>
					<div role="alert">{document.error}</div>
					<Button onClick={retry}>Retry loading the document</Button>
				</>
			) : (
				<DocBody text={document.markdown} index={index} />
			)}
		</div>
	);
}
