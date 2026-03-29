import { GitHubIcon } from "./github-icon";

export function Footer() {
	return (
		<footer className="border-t border-white/[0.06] px-6 py-6">
			<div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
				<p className="text-sm text-white/30 font-mono">
					usertrust · part of{" "}
					<a
						href="https://usertools.ai"
						target="_blank"
						rel="noopener noreferrer"
						className="text-white/50 hover:text-ut transition-colors duration-200"
					>
						usertools.ai
					</a>
				</p>

				<div className="flex flex-wrap items-center gap-4 text-sm text-white/30">
					<a
						href="https://userbank.ai"
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-white/70 transition-colors duration-200"
					>
						userbank.ai
					</a>
					<a
						href="https://userintel.ai"
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-white/70 transition-colors duration-200"
					>
						userintel.ai
					</a>
					<a
						href="https://usermemory.ai"
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-white/70 transition-colors duration-200"
					>
						usermemory.ai
					</a>
					<a
						href="https://github.com/usertools-ai/usertrust"
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-white/70 transition-colors duration-200 flex items-center gap-1.5"
					>
						<GitHubIcon className="w-3.5 h-3.5" />
						GitHub
					</a>
				</div>
			</div>
		</footer>
	);
}
