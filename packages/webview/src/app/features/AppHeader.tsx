import type { ReactNode } from "react";
import type { ViewDefinition } from "../extension.ts";
import type { BacklogIndex } from "../model/backlog.ts";
import { hashFor, type Params } from "../model/route.ts";
import { SearchIcon } from "../ui/icons.tsx";
import { cx, Kbd } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { HeaderMenu } from "./HeaderMenu.tsx";

/** The shell's one 48 px row: brand, view tabs, then what waits on you, the palette, New item and the menu. */
export function AppHeader({
	index,
	loaded = true,
	live,
	views,
	current,
	saved,
	badges,
	status,
	needsYou,
	actions,
	menu,
	onOpenPalette,
}: {
	index: BacklogIndex;
	loaded?: boolean;
	live: boolean;
	views: readonly ViewDefinition[];
	current: string;
	saved: Record<string, Params>;
	badges: Record<string, number>;
	status?: ReactNode;
	/** Something waits on the user: the pill opens or focuses the dialog from any view. */
	needsYou?: { count: number; open: boolean; controls: string; onToggle: () => void };
	/** Primary actions that stay in the row (New item). */
	actions?: ReactNode;
	/** Settings inside the menu popover (theme, notifications, terminal). */
	menu?: ReactNode;
	onOpenPalette: () => void;
}) {
	return (
		<div className="header-row">
			<div className="brand">
				<span className="brand-mark" aria-hidden="true" />
				<span>Octocode</span>
				<span className="brand-sep" aria-hidden="true">
					/
				</span>
				<h1>{index.repo}</h1>
			</div>
			<Tabs views={views} current={current} saved={saved} badges={badges} />
			<div className="header-actions">
				{needsYou && (
					<button
						type="button"
						id="needs-you-pill"
						className="needs-pill"
						aria-expanded={needsYou.open}
						aria-controls={needsYou.open ? needsYou.controls : undefined}
						onClick={needsYou.onToggle}
					>
						<StateMark state="waiting" size={12} />
						{needsYou.count} needs you
					</button>
				)}
				{status}
				<button
					type="button"
					className="palette-trigger"
					onClick={onOpenPalette}
					aria-keyshortcuts="Meta+K Control+K"
					title="Search or jump to…"
				>
					<SearchIcon />
					<span className="palette-label">Search or jump to…</span>
					<Kbd>⌘K</Kbd>
				</button>
				{actions}
				<HeaderMenu index={index} live={live} loaded={loaded}>
					{menu}
				</HeaderMenu>
			</div>
		</div>
	);
}

function Tabs({
	views,
	current,
	saved,
	badges,
}: {
	views: readonly ViewDefinition[];
	current: string;
	saved: Record<string, Params>;
	badges: Record<string, number>;
}) {
	return (
		<nav className="tabs" aria-label="Views">
			{views.map(({ name, label, Icon }) => (
				<a
					key={name}
					href={hashFor(name, saved[name])}
					className={cx("tab", name === current && "active")}
					aria-current={name === current ? "page" : undefined}
				>
					<Icon />
					{label}
					{badges[name] ? " " : null}
					{badges[name] ? (
						<span
							className={`tab-badge${name === "attention" ? " needs-attention" : ""}`}
							title={name === "attention" ? `${badges[name]} need attention` : `${badges[name]} planned items`}
						>
							{badges[name]}
						</span>
					) : null}
				</a>
			))}
		</nav>
	);
}
