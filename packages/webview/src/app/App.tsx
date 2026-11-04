import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { BacklogStore, LiveExtension, ViewDefinition } from "./extension.ts";
import { AppHeader, Tabs } from "./features/AppHeader.tsx";
import { AttentionView } from "./features/AttentionView.tsx";
import { BacklogView } from "./features/BacklogView.tsx";
import { BoardView } from "./features/BoardView.tsx";
import { buildCommands, CommandPalette, type PaletteCommand } from "./features/CommandPalette.tsx";
import { ItemDetail, MissingItem } from "./features/ItemDetail.tsx";
import { TableView } from "./features/TableView.tsx";
import { TreeView } from "./features/TreeView.tsx";
import { BoardSkeleton } from "./features/ViewSkeleton.tsx";
import { hasOpenModal, navigate, replaceHash, useHashRoute, useHotkeys } from "./hooks.ts";
import { attention, indexBacklog } from "./model/backlog.ts";
import { reportLinkHref } from "./model/reports.ts";
import { NEEDS_YOU_PANEL_ID, type NeedsYou, titleWithCount } from "./model/needs-you.ts";
import { hashFor, type Params, resolveRoute } from "./model/route.ts";
import { AlertIcon, BoardIcon, PlusIcon, TableIcon, TerminalIcon, TreeIcon } from "./ui/icons.tsx";
import { RichTextContext } from "./ui/LongText.tsx";
import { Button, Skeleton, SkeletonLine } from "./ui/primitives.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { StateMark } from "./ui/StateMark.tsx";

const BASE_VIEWS: readonly ViewDefinition[] = [
	{ name: "board", label: "Board", Icon: BoardIcon, Component: BoardView },
	{ name: "backlog", label: "Backlog", Icon: TableIcon, Component: BacklogView },
	{ name: "table", label: "Table", Icon: TableIcon, Component: TableView },
	{ name: "tree", label: "Tree", Icon: TreeIcon, Component: TreeView },
	{ name: "attention", label: "Attention", Icon: AlertIcon, Component: AttentionView },
];

const TERMINAL_HASH = "#activity?mode=terminal";

interface Navigation {
	view: string;
	params: Record<string, Params>;
}

/**
 * The shell: one view at a time from the hash, an item sheet over it, and a command palette. The background view
 * stays mounted while an item is open, so closing the sheet returns focus and scroll exactly where they were.
 */
export function App({
	backlog,
	live,
	access = "",
}: {
	backlog: BacklogStore;
	live: LiveExtension | null;
	access?: string;
}) {
	// The shell sits inside the live provider so it can read the session (what waits on the user).
	return live ? (
		<live.Provider access={access} backlog={backlog}>
			<Shell backlog={backlog} live={live} />
		</live.Provider>
	) : (
		<Shell backlog={backlog} live={null} />
	);
}

const noNeedsYou = (): NeedsYou | undefined => undefined;

/** Moves to the dialog the composer already shows (Activity), else opens the inline one; false when nothing waits. */
function focusInlineAnswer(): boolean {
	const inline = document.querySelector<HTMLElement>(".session-panel .dialog-answer");
	if (!inline) return false;
	inline.scrollIntoView?.({ block: "center" });
	inline.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus();
	return true;
}

function Shell({ backlog, live }: { backlog: BacklogStore; live: LiveExtension | null }) {
	const snapshot = useStore(backlog, (state) => state.snapshot);
	const loaded = useStore(backlog, (state) => state.loaded);
	const index = useMemo(() => indexBacklog(snapshot), [snapshot]);
	const views = useMemo(() => [...BASE_VIEWS, ...(live?.views ?? [])], [live]);
	// A read-only live page (a daemon repository scope) still reads, but the host refuses its writes: offer no edit control.
	const editable = live !== null && !live.readOnly;
	const destination = resolveRoute(
		useHashRoute(),
		views.map((view) => view.name),
	);

	// Adjust navigation state while rendering when the hash names a different view or filters (React's derived-state pattern).
	const [nav, setNav] = useState<Navigation>(() => ({
		view: destination.kind === "view" ? destination.view : "board",
		params: destination.kind === "view" ? { [destination.view]: destination.params } : {},
	}));
	if (
		destination.kind === "view" &&
		(destination.view !== nav.view ||
			hashFor(destination.view, destination.params) !== hashFor(destination.view, nav.params[destination.view]))
	) {
		setNav({ view: destination.view, params: { ...nav.params, [destination.view]: destination.params } });
	}

	const current = views.find((view) => view.name === nav.view) ?? views[0];
	const viewName = current.name;
	const setParams = useCallback(
		(params: Params) => {
			replaceHash(viewName, params);
			setNav((state) => ({ ...state, params: { ...state.params, [viewName]: params } }));
		},
		[viewName],
	);
	const backToView = () => navigate(hashFor(viewName, nav.params[viewName]));

	const needs = (live?.useNeedsYou ?? noNeedsYou)();
	const [needsOpen, setNeedsOpen] = useState(false);
	if (!needs && needsOpen) setNeedsOpen(false);
	const needsCount = needs?.count ?? 0;
	useEffect(() => {
		document.title = titleWithCount(document.title, needsCount);
		return () => {
			document.title = titleWithCount(document.title, 0);
		};
	}, [needsCount]);
	const answerWaiting = useCallback(() => {
		if (!focusInlineAnswer()) setNeedsOpen(true);
	}, []);
	const closeNeeds = useCallback(() => {
		setNeedsOpen(false);
		document.getElementById("needs-you-pill")?.focus();
	}, []);

	const [paletteOpen, setPaletteOpen] = useState(false);
	const closePalette = useCallback(() => setPaletteOpen(false), []);
	useHotkeys([
		{ key: "k", mod: true, allowInInput: true, run: () => setPaletteOpen((open) => !open) },
		{ key: "/", run: () => hasOpenModal() || document.querySelector<HTMLInputElement>("[data-search]")?.focus() },
		...(editable ? [{ key: "c", run: () => hasOpenModal() || navigate("#new") }] : []),
		...(live ? [{ key: "t", run: () => hasOpenModal() || navigate(TERMINAL_HASH) }] : []),
	]);

	const commands = useMemo(() => {
		const actions: PaletteCommand[] = [];
		if (needs) {
			actions.push({
				id: "action:answer",
				label: "Answer waiting question",
				group: "Actions",
				keywords: `approval approve deny dialog needs you ${needs.title}`,
				icon: <StateMark state="waiting" />,
				run: answerWaiting,
			});
		}
		if (editable) {
			actions.push({
				id: "action:new",
				label: "Create new item",
				group: "Actions",
				hint: "C",
				icon: <PlusIcon />,
				run: () => navigate("#new"),
			});
		}
		if (live) {
			actions.push({
				id: "action:terminal",
				label: "Open terminal view",
				group: "Actions",
				keywords: "shell commands tools bash",
				icon: <TerminalIcon />,
				hint: "T",
				run: () => navigate(TERMINAL_HASH),
			});
		}
		return buildCommands(index, views, navigate, actions);
	}, [index, views, live, editable, needs, answerWaiting]);

	const badges = useMemo(() => {
		const { claims, idle } = attention(index);
		return {
			attention: new Set([...claims, ...idle]).size,
			backlog: index.items.filter((item) => item.state === "backlog" || item.state === "todo").length,
		};
	}, [index]);

	const View = current.Component;
	const sheetOpen = destination.kind !== "view" && (destination.kind === "item" || editable);

	const app = (
		<RichTextContext.Provider value={live?.RichText ?? null}>
			<div className="shell" inert={sheetOpen || paletteOpen}>
				<header className="top" id="top">
					<AppHeader
						index={index}
						loaded={loaded}
						live={live !== null}
						status={live ? <live.ConnectionStatus /> : undefined}
						needsYou={
							needs
								? {
										count: needs.count,
										open: needsOpen,
										controls: NEEDS_YOU_PANEL_ID,
										onToggle: needsOpen ? closeNeeds : answerWaiting,
									}
								: undefined
						}
						actions={
							live ? (
								<>
									<Button
										icon={<TerminalIcon />}
										onClick={() => navigate(TERMINAL_HASH)}
										aria-keyshortcuts="T"
										title="Terminal view of this session's commands (T)"
									>
										Terminal
									</Button>
									{editable && (
										<Button
											variant="primary"
											icon={<PlusIcon />}
											onClick={() => navigate("#new")}
											aria-keyshortcuts="C"
										>
											New item
										</Button>
									)}
								</>
							) : undefined
						}
						onOpenPalette={() => setPaletteOpen(true)}
					/>
					<Tabs views={views} current={current.name} saved={nav.params} badges={badges} />
					{live && needs && needsOpen && <live.NeedsYouAnswer needs={needs} onClose={closeNeeds} />}
				</header>
				<main id="main">
					{!loaded && BASE_VIEWS.includes(current) ? (
						<BoardSkeleton />
					) : (
						<View
							key={current.name}
							index={index}
							params={nav.params[current.name] ?? {}}
							setParams={setParams}
							ItemAction={editable ? live.ItemQuickAction : undefined}
							controls={editable ? live.controls : undefined}
						/>
					)}
				</main>
			</div>
			{sheetOpen && (
				<ItemSheet
					destination={destination}
					index={index}
					live={live}
					editable={editable}
					loaded={loaded}
					onClose={backToView}
				/>
			)}
			{paletteOpen && <CommandPalette commands={commands} onClose={closePalette} />}
		</RichTextContext.Provider>
	);
	return app;
}

function ItemSheet({
	destination,
	index,
	live,
	editable,
	loaded,
	onClose,
}: {
	destination: Exclude<ReturnType<typeof resolveRoute>, { kind: "view" }>;
	index: ReturnType<typeof indexBacklog>;
	live: LiveExtension | null;
	editable: boolean;
	loaded: boolean;
	onClose: () => void;
}) {
	const item = destination.kind === "item" ? index.byRef.get(destination.ref) : undefined;
	const editing =
		live &&
		editable &&
		(destination.kind === "new" || (item && destination.kind === "item" && destination.mode !== "view"));
	const titleFocus = () => document.getElementById("item-title");
	const fieldFocus = () => document.querySelector<HTMLElement>("#drawer [data-autofocus]");

	if (editing) {
		const correction = destination.kind === "item" && destination.mode === "correct";
		return (
			<Sheet
				labelledBy="editor-title"
				onClose={onClose}
				initialFocus={fieldFocus}
				key={`edit:${item?.ref ?? "new"}:${correction}`}
			>
				<live.Editor
					item={item}
					correction={correction}
					onClose={(ref) => (ref ? navigate(`#${ref}`) : item ? navigate(`#${item.ref}`) : onClose())}
				/>
			</Sheet>
		);
	}
	return (
		<Sheet
			labelledBy="item-title"
			onClose={onClose}
			initialFocus={titleFocus}
			focusKey={`${destination.kind === "item" ? destination.ref : "new"}:${loaded}:${Boolean(item)}`}
		>
			{!loaded ? (
				<div className="sheet-body">
					<Button onClick={onClose}>Close</Button>
					<h2 id="item-title" tabIndex={-1}>
						Loading item…
					</h2>
					<Skeleton label="Loading item details">
						<SkeletonLine />
						<SkeletonLine width="70%" />
					</Skeleton>
				</div>
			) : item ? (
				<ItemDetail
					key={item.ref}
					item={item}
					index={index}
					onClose={onClose}
					actions={
						live ? (
							editable ? (
								<live.ItemActions item={item} />
							) : (
								<p className="muted">
									This board is read-only here. Open the repository's session to edit items or start implementation.
								</p>
							)
						) : undefined
					}
					activity={live && editable ? <live.ItemActivity item={item} /> : undefined}
					tasks={live && editable && item.type !== "epic" ? <live.controls.ItemTasks item={item} /> : undefined}
					reportHref={live ? reportLinkHref : undefined}
				/>
			) : (
				<MissingItem refName={destination.kind === "item" ? destination.ref : "Item"} onClose={onClose} />
			)}
		</Sheet>
	);
}
