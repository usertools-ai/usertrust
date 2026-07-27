import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

export const { GET } = createFromSource(source, {
	language: "english",
	buildIndex(page) {
		return {
			id: page.url,
			title: page.data.title,
			description: page.data.description,
			url: page.url,
			structuredData: page.data.structuredData ?? { headings: [], contents: [] },
		};
	},
});
