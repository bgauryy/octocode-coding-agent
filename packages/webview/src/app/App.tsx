import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { BacklogStore, LiveExtension, ViewDefinition } from "./extension.ts";
import { AppHeader } from "./features/AppHeader.tsx";
import { ItemSheet } from "./ItemSheet.tsx";
import { ThemeToggle } from "./features/ThemeToggle.tsx";
import { useTheme } from "./theme.ts";
import { AttentionView } from "./features/AttentionView.tsx";
import { BacklogView } from "./features/BacklogView.tsx";
import { BoardView } from "./features/BoardView.tsx";
import { buildCommands, CommandPalette, type PaletteCommand } from "./features/CommandPalette.tsx";
import { TableView } from "./features/TableView.tsx";
import { TreeView } from "./features/TreeView.tsx";
import { BoardSkeleton } from "./features/ViewSkeleton.tsx";
import { hasOpenModal, navigate, replaceHash, useHashRoute, useHotkeys } from "./hooks.ts";
import { attention, indexBacklog } from "./model/backlog.ts";
import { NEEDS_YOU_PANEL_ID, type NeedsYou, titleWithCount } from "./model/needs-you.ts";
import { hashFor, type Params, resolveRoute } from "./model/route.ts";
import { AlertIcon, BoardIcon, PlusIcon, TableIcon, TerminalIcon, TreeIcon } from "./ui/icons.tsx";
import { RichTextContext } from "./ui/LongText.tsx";
import { Button } from "./ui/primitives.tsx";
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
			<Shell backlog={backlog} live={live} access={access} />
		</live.Provider>
	) : (
		<Shell backlog={backlog} live={null} access={null} />
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

function Shell({
	backlog,
	live,
	access,
}: {
	backlog: BacklogStore;
	live: LiveExtension | null;
	access: string | null;
}) {
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
	// An old link (`#agents`) lands on the view that replaced it; make the address say so, without a history entry.
	const movedTo =
		destination.kind === "view" && destination.moved ? hashFor(destination.view, destination.params) : undefined;
	useEffect(() => {
		if (movedTo) history.replaceState(null, "", movedTo);
	}, [movedTo]);

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
	const pageTitle = `${current.label} · Octocode`;
	useEffect(() => {
		document.title = titleWithCount(pageTitle, needsCount);
		return () => {
			document.title = titleWithCount(document.title, 0);
		};
	}, [pageTitle, needsCount]);
	const { theme, setTheme, problem: themeProblem } = useTheme(live?.themePrefs, access, editable);
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
				<a
					className="skip-link"
					href="#main"
					onClick={(event) => {
						event.preventDefault();
						document.getElementById("main")?.focus();
					}}
				>
					Skip to content
				</a>
				<header className="top" id="top">
					<AppHeader
						index={index}
						loaded={loaded}
						live={live !== null}
						views={views}
						current={current.name}
						saved={nav.params}
						badges={badges}
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
							editable ? (
								<Button variant="primary" icon={<PlusIcon />} onClick={() => navigate("#new")} aria-keyshortcuts="C">
									New item
								</Button>
							) : undefined
						}
						menu={
							<>
								<ThemeToggle theme={theme} onChange={setTheme} problem={themeProblem} />
								{live && (
									<>
										<live.Notifications />
										<Button
											icon={<TerminalIcon />}
											onClick={() => navigate(TERMINAL_HASH)}
											aria-keyshortcuts="T"
											title="Terminal view of this session's commands (T)"
										>
											Terminal
										</Button>
									</>
								)}
							</>
						}
						onOpenPalette={() => setPaletteOpen(true)}
					/>
					{live && needs && needsOpen && <live.NeedsYouAnswer needs={needs} onClose={closeNeeds} />}
				</header>
				<main id="main" tabIndex={-1}>
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
