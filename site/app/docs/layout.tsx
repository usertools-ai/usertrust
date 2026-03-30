import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<RootProvider
			theme={{
				defaultTheme: "dark",
				forcedTheme: "dark",
			}}
		>
			<DocsLayout tree={source.getPageTree()} {...baseOptions()}>
				{children}
			</DocsLayout>
		</RootProvider>
	);
}
