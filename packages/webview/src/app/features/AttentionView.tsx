import { useMemo } from "react";
import type { ViewProps } from "../extension.ts";
import { attention } from "../model/backlog.ts";
import { ago, span } from "../model/format.ts";
import { CheckIcon } from "../ui/icons.tsx";
import { EmptyState } from "../ui/primitives.tsx";
import { ItemLine } from "./shared.tsx";

export function AttentionView({ index }: ViewProps) {
	const { claims, idle } = useMemo(() => attention(index), [index]);
	return (
		<div className="view attention-view">
			<section className="panel" aria-labelledby="stale-claims">
				<header className="panel-header">
					<h2 id="stale-claims">
						Stale claims <span className="count">{claims.length}</span>
					</h2>
					<p className="muted">
						In-progress items whose assignee was not a running session when the snapshot was made.
					</p>
				</header>
				{claims.length ? (
					<ul className="row-list">
						{claims.map((it) => (
							<li key={it.ref}>
								<ItemLine item={it}>
									<span className="row-reason">
										{it.assignee ? `${it.assignee} is not running` : "no assignee"}
										{it.startedAt ? ` · claimed ${ago(index.now, it.startedAt)}` : ""}
									</span>
								</ItemLine>
							</li>
						))}
					</ul>
				) : (
					<EmptyState icon={<CheckIcon size={20} />} title="No stale claims" />
				)}
			</section>
			<section className="panel" aria-labelledby="idle-items">
				<header className="panel-header">
					<h2 id="idle-items">
						Not updated in {span(index.idleMs)} <span className="count">{idle.length}</span>
					</h2>
					<p className="muted">Open items with no change or note since then, oldest first.</p>
				</header>
				{idle.length ? (
					<ul className="row-list">
						{idle.map((it) => (
							<li key={it.ref}>
								<ItemLine item={it}>
									<span className="row-reason">last update {ago(index.now, it.updatedAt)}</span>
								</ItemLine>
							</li>
						))}
					</ul>
				) : (
					<EmptyState icon={<CheckIcon size={20} />} title="Everything open moved recently" />
				)}
			</section>
		</div>
	);
}
