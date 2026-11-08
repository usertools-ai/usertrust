// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The windows the desk shows, in grid order. Registration is static: each window file exports one prop-less component
 * that renders its own `Window`, so a window's title, subtitle and actions belong to the PR that owns it. This list
 * imports all four already; no later change edits it.
 */

import type { ComponentType } from "react";
import type { WindowId } from "../../shared/desk-layout.js";
import { LedgerWindow } from "../windows/ledger/ledger-window.js";
import { NowWindow } from "../windows/now/now-window.js";
import { ShareWindow } from "../windows/share/share-window.js";
import { SpendWindow } from "../windows/spend/spend-window.js";

export const WINDOWS: readonly { id: WindowId; Component: ComponentType }[] = [
	{ id: "spend", Component: SpendWindow },
	{ id: "share", Component: ShareWindow },
	{ id: "ledger", Component: LedgerWindow },
	{ id: "now", Component: NowWindow },
];
