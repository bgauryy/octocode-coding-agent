import { type SessionInfo, type SessionListProgress, SessionManager } from "../../../core/session-manager.ts";
import type { SessionPickerOptions } from "../../../core/session-picker.ts";
import { SessionSelectorComponent } from "../components/session-selector.ts";
import type { InteractiveModeHost } from "./host.ts";

type SessionPickerHost = Pick<InteractiveModeHost, "session" | "sessionManager" | "showCustomDialog" | "ui">;

/**
 * `SessionUI.pickSession`: the session selector in place of the editor. Resolves with the session picked, or
 * undefined on cancel. A host action runs once the picker has closed, because its dialogs need the editor slot.
 */
export async function pickSession(
	host: SessionPickerHost,
	options: SessionPickerOptions,
): Promise<SessionInfo | undefined> {
	// Every row the picker can show (quick first page, partial and full listings), so a pick made while loading resolves.
	const known = new Map<string, SessionInfo>();
	const remember = (infos: readonly SessionInfo[]) => infos.forEach((info) => known.set(info.path, info));
	const { onlySessions } = options;
	const only = <T extends readonly SessionInfo[]>(infos: T): T | SessionInfo[] =>
		onlySessions ? infos.filter((info) => onlySessions.has(info.id)) : infos;
	const tracking =
		(onProgress?: SessionListProgress): SessionListProgress =>
		(loaded, total, partial) => {
			if (partial) remember(partial);
			onProgress?.(loaded, total, partial && only(partial));
		};
	const { quickList } = options;
	let afterClose: Promise<void> | undefined;
	const manager = host.sessionManager;
	const picked = await host.showCustomDialog<SessionInfo | undefined>(
		(tui, _theme, keybindings, done) =>
			new SessionSelectorComponent(
				async (onProgress, signal) => {
					const infos = await SessionManager.list(
						manager.getCwd(),
						manager.getSessionDir(),
						tracking(onProgress),
						signal,
					);
					remember(infos);
					return only(infos);
				},
				async (onProgress, signal) => {
					const infos = manager.usesDefaultSessionDir()
						? await SessionManager.listAll(tracking(onProgress), signal)
						: await SessionManager.listAll(manager.getSessionDir(), tracking(onProgress), signal);
					remember(infos);
					return only(infos);
				},
				(file) => done(known.get(file)),
				() => done(undefined),
				() => done(undefined),
				() => tui.requestRender(),
				{
					keybindings,
					...options,
					...(quickList
						? {
								quickList: async (scope, signal) => {
									const infos = await quickList(scope, signal);
									remember(infos);
									return only(infos);
								},
							}
						: {}),
					initialSort: "recent",
					showRenameHint: true,
					viewportRows: options.viewportRows ?? (() => tui.terminal.rows - 1),
					actions: options.actions?.map((action) => ({
						label: action.label,
						run: (session) => {
							done(undefined);
							afterClose = Promise.resolve(action.run(session));
						},
					})),
					renameSession: async (file, name) => {
						const next = (name ?? "").trim();
						if (!next) return;
						// The open session is live in this process: rename through it. Another file has no live manager here.
						if (!file || file === manager.getSessionFile()) host.session.setSessionName(next);
						else (await SessionManager.openAsync(file)).appendSessionInfo(next);
					},
				},
				manager.getSessionFile(),
			),
	);
	await afterClose;
	return picked;
}
