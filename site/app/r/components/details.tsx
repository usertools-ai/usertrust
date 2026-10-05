import type { ReactNode } from "react";

/**
 * The ONE disclosure on a page: everything that is not the glance. Nothing in
 * it is deleted from the page; it is folded. Sentences the spec says may never
 * sit behind interaction (the amount's scope, the anchoring disclosure, the
 * rung's fine print) are rendered outside it.
 */
export default function Details({
	children,
	label = "Details",
}: {
	children: ReactNode;
	label?: string;
}) {
	return (
		<details className="ut-details" data-testid="details">
			<summary>{label}</summary>
			<div className="ut-details-body">{children}</div>
		</details>
	);
}
