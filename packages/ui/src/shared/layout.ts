// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The widest viewport laid out as a phone. The stylesheet's narrow-screen block repeats this number in its
 * `@media (max-width: …)` query (a test pins that they agree), and the components that must act differently on a
 * phone (the list scrolls with the page, the filters open as a sheet) ask the same question through `PHONE_QUERY`.
 */
export const PHONE_MAX_WIDTH = 760;

export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
