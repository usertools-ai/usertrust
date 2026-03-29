import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const usertoolsSans = localFont({
	src: [
		{ path: "../public/fonts/UsertoolsSans-Regular.woff2", weight: "400" },
		{ path: "../public/fonts/UsertoolsSans-Medium.woff2", weight: "500" },
		{ path: "../public/fonts/UsertoolsSans-Bold.woff2", weight: "600 700" },
	],
	variable: "--font-usertools",
	display: "swap",
});

const jetbrainsMono = localFont({
	src: [{ path: "../public/fonts/JetBrainsMono[wght].woff2", weight: "400 700" }],
	variable: "--font-jetbrains",
	display: "swap",
});

export const metadata: Metadata = {
	title: "usertrust — trust() your AI spend",
	description:
		"Budget holds, audit trails, and spend limits for every LLM call. Keep your keys, keep your billing. Add trust in one line.",
	keywords: [
		"AI governance",
		"LLM spend",
		"budget holds",
		"audit trail",
		"usertrust",
		"trust",
		"AI finance",
		"agent governance",
		"OpenAI",
		"Anthropic",
		"SDK",
	],
	metadataBase: new URL("https://usertrust.ai"),
	alternates: { canonical: "/" },
	openGraph: {
		title: "usertrust — trust() your AI spend",
		description:
			"Budget holds, audit trails, and spend limits for every LLM call. Keep your keys, keep your billing. Add trust in one line.",
		url: "https://usertrust.ai",
		siteName: "UserTrust",
		images: [{ url: "/og.png" }],
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "usertrust — trust() your AI spend",
		description:
			"Budget holds, audit trails, and spend limits for every LLM call. Keep your keys, keep your billing. Add trust in one line.",
		images: ["/og.png"],
	},
	icons: { icon: "/favicon.svg" },
};

const jsonLd = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	name: "UserTrust",
	applicationCategory: "DeveloperApplication",
	license: "https://www.apache.org/licenses/LICENSE-2.0",
	offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
	author: { "@type": "Organization", name: "Usertools Inc" },
	url: "https://usertrust.ai",
	description: "Budget holds, audit trails, and spend limits for every LLM call.",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" className={`${usertoolsSans.variable} ${jetbrainsMono.variable}`}>
			<body className="bg-brand-bg text-white font-sans antialiased overflow-x-hidden">
				{children}
				<script
					type="application/ld+json"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD structured data requires this pattern
					dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
				/>
			</body>
		</html>
	);
}
