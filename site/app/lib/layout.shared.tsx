import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: "usertrust",
			url: "/",
		},
		githubUrl: "https://github.com/usertools-ai/usertrust",
		links: [
			{
				text: "Documentation",
				url: "/docs",
				active: "nested-url",
			},
		],
	};
}
