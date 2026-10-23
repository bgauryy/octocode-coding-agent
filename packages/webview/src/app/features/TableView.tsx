import { useMemo } from "react";
import type { ViewProps } from "../extension.ts";
import {
	DEFAULT_SORT,
	distinct,
	filterTable,
	PRIORITIES,
	PRIORITY_TITLES,
	STATE_TITLES,
	TABLE_COLUMNS,
	type TableColumn,
} from "../model/backlog.ts";
import { FilterSelect, SearchField } from "../ui/fields.tsx";
import { SortIcon } from "../ui/icons.tsx";
import { Avatar, PriorityIcon, RelativeTime, StatusLabel } from "../ui/primitives.tsx";
import { compact, ResultCount, StaleBadge, Toolbar } from "./shared.tsx";

type Filter = "q" | "state" | "p" | "tag" | "assignee" | "sort" | "dir";

export function TableView({ index, params, setParams }: ViewProps) {
	const { q = "", state = "", p = "", tag = "", assignee = "" } = params;
	const sort = TABLE_COLUMNS.some((column) => column.key === params.sort) ? params.sort : DEFAULT_SORT.sort;
	const dir =
		params.dir === "asc" || params.dir === "desc" ? params.dir : sort === DEFAULT_SORT.sort ? DEFAULT_SORT.dir : "asc";
	const shown = useMemo(
		() => filterTable(index, { q, state, p, tag, assignee, sort, dir }),
		[index, q, state, p, tag, assignee, sort, dir],
	);
	const tags = useMemo(() => distinct(index.items, (it) => it.tags), [index]);
	const assignees = useMemo(() => distinct(index.items, (it) => (it.assignee ? [it.assignee] : [])), [index]);

	function update(patch: Partial<Record<Filter, string>>) {
		const next = { q, state, p, tag, assignee, sort, dir, ...patch };
		const plain = next.sort === DEFAULT_SORT.sort && next.dir === DEFAULT_SORT.dir;
		setParams(compact({ ...next, sort: plain ? "" : next.sort, dir: plain ? "" : next.dir }));
	}
	function toggleSort(column: TableColumn) {
		update({ sort: column.key, dir: sort === column.key ? (dir === "asc" ? "desc" : "asc") : column.first });
	}

	return (
		<div className="view table-view">
			<Toolbar label="Table filters">
				<SearchField
					data-search=""
					label="Search"
					placeholder="Search every field and note"
					shortcut="/"
					value={q}
					onChange={(event) => update({ q: event.target.value })}
				/>
				<FilterSelect
					label="State"
					options={index.states.map((value) => ({ value, label: STATE_TITLES[value] }))}
					value={state}
					onChange={(value) => update({ state: value })}
				/>
				<FilterSelect
					label="Priority"
					options={PRIORITIES.map((value) => ({ value, label: `${value} · ${PRIORITY_TITLES[value]}` }))}
					value={p}
					onChange={(value) => update({ p: value })}
				/>
				<FilterSelect label="Tag" options={tags} value={tag} onChange={(value) => update({ tag: value })} />
				<FilterSelect
					label="Assignee"
					options={assignees}
					value={assignee}
					onChange={(value) => update({ assignee: value })}
				/>
				<ResultCount shown={shown.length} total={index.items.length} />
			</Toolbar>
			{/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-scrollable. */}
			<section className="table-scroll" aria-label="Tasks table" tabIndex={0}>
				<table className="data-table">
					<thead>
						<tr>
							{TABLE_COLUMNS.map((column) => {
								const active = column.key === sort;
								return (
									<th
										key={column.key}
										scope="col"
										className={column.numeric ? "num" : undefined}
										aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
									>
										<button type="button" className="sort-button" onClick={() => toggleSort(column)}>
											{column.label}
											<SortIcon size={12} direction={active ? dir : undefined} />
										</button>
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{shown.map((it) => (
							<tr key={it.ref}>
								<td>
									<a className="ref" href={`#${it.ref}`}>
										{it.ref}
									</a>
								</td>
								<td className="nowrap">
									<StatusLabel state={it.state} /> <StaleBadge item={it} />
								</td>
								<td className="nowrap">
									<span className="priority-cell">
										<PriorityIcon priority={it.priority} />
										{it.priority}
									</span>
								</td>
								<td className="title-cell">
									<a href={`#${it.ref}`}>{it.title}</a>
								</td>
								<td className="truncate" title={it.assignee}>
									{it.assignee && (
										<span className="assignee">
											<Avatar name={it.assignee} />
											{it.assignee}
										</span>
									)}
								</td>
								<td className="truncate muted" title={it.tags.join(" ")}>
									{it.tags.map((t) => `#${t}`).join(" ")}
								</td>
								<td className="nowrap muted">
									<RelativeTime at={it.updatedAt} now={index.now} />
								</td>
								<td className="nowrap muted">
									<RelativeTime at={it.createdAt} now={index.now} />
								</td>
								<td className="num">{it.notes.length}</td>
								<td className="num">{it.derived.length}</td>
							</tr>
						))}
						{!shown.length && (
							<tr>
								<td colSpan={TABLE_COLUMNS.length} className="table-empty">
									No item matches.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</section>
		</div>
	);
}
