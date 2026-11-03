// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The dashboard's tab icon, derived from the bundled mark at build time. The repository holds exactly one brand file
 * (`brand/usertrust-mark.svg`, pinned by hash), so the icon is that file cropped, never a second copy: the mark's
 * left square is the gold chip with `ut` (the name's pill starts at x = 276), and only the root `viewBox` changes.
 */
const MARK_VIEW_BOX = 'viewBox="0 0 942 256"';
const CHIP_VIEW_BOX = 'viewBox="0 0 256 256"';

/** The mark with its `viewBox` cropped to the chip. Refuses a mark whose `viewBox` is not the one this crop was cut for. */
export function cropMarkToChip(markSvg: string): string {
	const root = markSvg.match(/<svg\b[^>]*>/)?.[0] ?? "";
	if (!root.includes(MARK_VIEW_BOX)) {
		throw new Error(
			`the mark's root <svg> has no ${MARK_VIEW_BOX}: the chip crop was cut for that box, so change the crop with the mark`,
		);
	}
	return markSvg.replace(MARK_VIEW_BOX, CHIP_VIEW_BOX);
}

/** The `href` of a `<link rel="icon">` for the chip crop of `markSvg`: a data URI, no request. */
export function faviconHref(markSvg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(cropMarkToChip(markSvg).trim())}`;
}
