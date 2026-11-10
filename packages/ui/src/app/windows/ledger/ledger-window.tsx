// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The Ledger window. Day one it holds the list and the record panel the page always drew, moved here unchanged: PR 5
 * replaces this file's body. Filled at a wide window the panel docks beside the list; otherwise the open record opens
 * as the drawer.
 */

import { memo, useCallback, useRef, useState } from "react";
import { DOCK_QUERY } from "../../../shared/desk-layout.js";
import type { LedgerRow } from "../../../shared/rows.js";
import { AuditTable } from "../../audit-table.js";
import {
	useDeskData,
	useFilters,
	useHoverMoment,
	useOpenRecord,
	usePosition,
} from "../../desk/desk-state.js";
import { useMedia } from "../../desk/use-box-size.js";
import { Window } from "../../desk/window.js";
import { InspectorHint, RowPanel } from "../../row-panel.js";

export const LedgerWindow = memo(function LedgerWindow(): React.JSX.Element {
	const { list, liveIds, held, pastNote } = useDeskData();
	const { clear } = useFilters();
	const { openHash, setOpenHash, open } = useOpenRecord();
	// The list marks the pinned position's record, and the hour another window points at.
	const { at } = usePosition();
	const pointed = useHoverMoment("ledger");
	// Wide by default (the server's answer): the docked panel only exists on a desktop window, and a browser reads the
	// real width at once.
	const wide = useMedia(DOCK_QUERY, true);
	// Enter or Space on a row asks the docked inspector to take focus; a click clears the request. The restore request
	// sends focus back to the row when the inspector closes. Each carries a counter so a repeat of the same row counts.
	const [kbOpen, setKbOpen] = useState<number | undefined>(undefined);
	const [restoreFocus, setRestoreFocus] = useState<{ hash: string; n: number } | null>(null);
	const requests = useRef(0);
	const close = useCallback(
		(returnFocus: boolean) => {
			if (returnFocus && openHash !== null)
				setRestoreFocus({ hash: openHash, n: ++requests.current });
			setOpenHash(null);
			setKbOpen(undefined);
		},
		[openHash, setOpenHash],
	);
	// Stable, so the memoized list does not re-render for a new callback on every answer.
	const openRow = useCallback(
		(r: LedgerRow, viaKeyboard: boolean) => {
			setOpenHash(r.hash);
			setKbOpen(viaKeyboard ? ++requests.current : undefined);
		},
		[setOpenHash],
	);

	return (
		<Window id="ledger" title="Ledger">
			{(filled, dimmed) => {
				// An empty vault has nothing to select: the list takes the width.
				const docked = filled && wide && list.shownRows.length > 0;
				return (
					<>
						<div className="ut-lg-body" data-docked={docked}>
							<div className="ut-lg-list">
								<AuditTable
									rows={list.filtered}
									total={list.total}
									phase={list.phase}
									chain={list.chain}
									beforeWindow={list.beforeWindow}
									reloading={list.reloading}
									reloadingNote={pastNote}
									liveIds={liveIds}
									selected={openHash}
									restoreFocus={restoreFocus}
									pinnedPos={at}
									hourSpan={pointed?.span ?? null}
									onOpen={openRow}
									onClearFilters={clear}
								/>
							</div>
							{docked &&
								(open ? (
									// Keyed by the row: another row's inspector starts clean.
									<RowPanel
										key={open.hash}
										row={open}
										docked
										held={held}
										past={list.at !== null}
										onClose={close}
										focusNonce={kbOpen}
										onFocusHandled={() => setKbOpen(undefined)}
									/>
								) : (
									<InspectorHint />
								))}
						</div>
						{/* While another window fills the desk this one is inert and hidden: a modal in it could take no focus, and its
						    Tab handler held the keyboard. The record stays in the address, and its drawer opens (and takes focus)
						    when the Ledger shows again. */}
						{!docked && open && !dimmed && (
							<RowPanel
								key={open.hash}
								row={open}
								docked={false}
								held={held}
								past={list.at !== null}
								onClose={close}
							/>
						)}
					</>
				);
			}}
		</Window>
	);
});
