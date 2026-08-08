"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * IO-once reveal wrapper. Server/no-JS HTML has NO data-inview attribute, so
 * CSS keyed on [data-inview="false"] can never hide content from users
 * without JS. After hydration the wrapper is stamped data-inview="false",
 * then data-inview="true" the first time it intersects — set once, never
 * unset, observer disconnected. Reduced-motion skips straight to "true"
 * (finished states, not disabled features).
 */
export default function InView({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"ssr" | "waiting" | "inview">("ssr");

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setState("inview");
			return;
		}
		setState("waiting");
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setState("inview");
						io.disconnect();
					}
				}
			},
			{ rootMargin: "0px 0px -10% 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	return (
		<div
			ref={ref}
			className={className}
			data-inview={state === "ssr" ? undefined : state === "inview" ? "true" : "false"}
		>
			{children}
		</div>
	);
}
