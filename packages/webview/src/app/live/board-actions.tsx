import { DEFAULT_ITEM_TYPE } from "@octocodeai/octocode-contracts/backlogs";
import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type ReactNode, useCallback, useMemo } from "react";
import { type BoardActions, BoardActionsProvider } from "../features/board-context.tsx";
import type { Slot } from "../features/board-slot.ts";
import { CloseItemDialog } from "./CloseItem.tsx";
import { tryRefresh } from "./refresh.ts";
import { useLive } from "./session.tsx";

/** Gives the board its writes. The host decides every rule; a refusal rejects with its one-line message and the board reloads. */
export function BoardProvider({ children }: { children: ReactNode }) {
	const { api, refresh } = useLive();
	/** The live push also delivers the change; reloading covers a missed push and shows the current copy after a conflict. */
	const settle = useCallback(
		async (send: () => Promise<unknown>) => {
			let failure: unknown;
			try {
				await send();
			} catch (error) {
				failure = error;
			}
			const refreshed = await tryRefresh(refresh);
			if (failure === undefined) return { refreshed };
			const message = errorMessage(failure);
			throw new Error(refreshed ? message : `${message} The board could not be refreshed: reload the page.`);
		},
		[refresh],
	);
	const actions = useMemo<BoardActions>(
		() => ({
			async move(item: SnapshotItem, state: State, note?: string) {
				let version: number | undefined;
				const { refreshed } = await settle(async () => {
					const result = await api.backlogCommand({
						command: "item.state",
						id: item.ref,
						version: item.version,
						state,
						...(note ? { note } : {}),
					});
					version = result.item?.version;
				});
				return { refreshed, version };
			},
			async rank(item: SnapshotItem, slot: Slot, version?: number) {
				return settle(() =>
					api.backlogCommand({
						command: "item.rank",
						id: item.ref,
						version: version ?? item.version,
						...(slot.before === undefined ? {} : { before: slot.before }),
						...(slot.after === undefined ? {} : { after: slot.after }),
					}),
				);
			},
			async add(title: string, state: State) {
				return settle(() => api.mutate({ op: "add", title, state, type: DEFAULT_ITEM_TYPE }));
			},
			CloseDialog: CloseItemDialog,
		}),
		[api, settle],
	);
	return <BoardActionsProvider value={actions}>{children}</BoardActionsProvider>;
}
