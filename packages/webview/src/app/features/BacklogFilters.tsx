import { ITEM_TYPES } from "@octocodeai/octocode-contracts/backlogs";
import { useMemo, useRef } from "react";
import type { ViewProps } from "../extension.ts";
import { distinct, PRIORITY_OPTIONS } from "../model/backlog.ts";
import { FilterSelect, SearchField, Select } from "../ui/fields.tsx";
import { Button } from "../ui/primitives.tsx";
import { compact, ResultCount, Toolbar } from "./shared.tsx";

export function BacklogFilters({ index, params, setParams, shown }: ViewProps & { shown: number }) {
	const search = useRef<HTMLInputElement>(null);
	const { q = "", p = "", type = "", ready = "", assignee = "", tag = "", sort = "" } = params;
	const assignees = useMemo(() => distinct(index.items, (item) => (item.assignee ? [item.assignee] : [])), [index]);
	const tags = useMemo(() => distinct(index.items, (item) => item.tags), [index]);
	const update = (patch: Record<string, string>) =>
		setParams(compact({ q, p, type, ready, assignee, tag, sort, ...patch }));
	return (
		<Toolbar label="Board filters">
			<SearchField
				ref={search}
				data-search=""
				label="Search tasks"
				placeholder="Search title, ID, or comments…"
				shortcut="/"
				value={q}
				onChange={(event) => update({ q: event.target.value })}
			/>
			<FilterSelect label="Priority" options={PRIORITY_OPTIONS} value={p} onChange={(value) => update({ p: value })} />
			<FilterSelect label="Type" options={ITEM_TYPES} value={type} onChange={(value) => update({ type: value })} />
			<FilterSelect
				label="Assignee"
				options={assignees}
				value={assignee}
				onChange={(value) => update({ assignee: value })}
			/>
			<FilterSelect label="Tag" options={tags} value={tag} onChange={(value) => update({ tag: value })} />
			<Button
				size="sm"
				className="toggle"
				aria-pressed={ready === "ready"}
				onClick={() => update({ ready: ready ? "" : "ready" })}
			>
				Ready to start
			</Button>
			{Boolean(q || p || type || ready || assignee || tag) && (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						setParams(compact({ sort }));
						search.current?.focus();
					}}
				>
					Clear filters
				</Button>
			)}
			<Select
				className="filter-select board-sort"
				aria-label="Sort items"
				value={sort === "updated" ? "updated" : ""}
				options={[
					{ value: "", label: "Priority first" },
					{ value: "updated", label: "Recently updated" },
				]}
				onChange={(event) => update({ sort: event.target.value })}
			/>
			<ResultCount shown={shown} total={index.items.length} />
		</Toolbar>
	);
}
