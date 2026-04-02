import { GitHubIcon } from "./github-icon";

export function Footer() {
	return (
		<footer className="relative">
			<div className="h-px bg-gradient-to-r from-transparent via-ut/15 to-transparent" />
			<div className="max-w-5xl mx-auto px-6 py-12">
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-10">
					{/* Brand column */}
					<div className="col-span-2 sm:col-span-1 flex flex-col gap-3">
						<span className="font-mono text-ut font-semibold text-sm">usertrust</span>
						<p className="text-xs text-white/30 leading-relaxed max-w-[200px]">
							Financial governance for AI agents. Open source. Apache 2.0.
						</p>
					</div>

					{/* Product */}
					<div className="flex flex-col gap-2.5">
						<span className="text-xs font-medium text-white/50 uppercase tracking-wider">
							Product
						</span>
						<a
							href="#features"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Features
						</a>
						<a
							href="#how"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							How it works
						</a>
						<a
							href="#code"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Quick start
						</a>
						<a
							href="/docs"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Docs
						</a>
					</div>

					{/* Resources */}
					<div className="flex flex-col gap-2.5">
						<span className="text-xs font-medium text-white/50 uppercase tracking-wider">
							Resources
						</span>
						<a
							href="https://github.com/usertools-ai/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							GitHub
						</a>
						<a
							href="https://www.npmjs.com/package/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							npm
						</a>
						<a
							href="https://github.com/usertools-ai/usertrust/blob/master/LICENSE"
							target="_blank"
							rel="noopener noreferrer"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							License
						</a>
					</div>

					{/* Company */}
					<div className="flex flex-col gap-2.5">
						<span className="text-xs font-medium text-white/50 uppercase tracking-wider">
							Company
						</span>
						<a
							href="https://usertools.ai"
							target="_blank"
							rel="noopener noreferrer"
							className="animated-underline text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Usertools
						</a>
					</div>
				</div>

				{/* Bottom bar */}
				<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-6 border-t border-white/[0.04]">
					<p className="text-xs text-white/20">
						usertrust · part of{" "}
						<a
							href="https://usertools.ai"
							target="_blank"
							rel="noopener noreferrer"
							className="text-white/30 hover:text-ut transition-colors duration-200"
						>
							usertools.ai
						</a>
					</p>
					<div className="flex items-center gap-4">
						<button
							type="button"
							onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
							className="text-xs text-white/20 hover:text-ut transition-colors duration-200"
						>
							Back to top ↑
						</button>
						<a
							href="https://github.com/usertools-ai/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1.5 text-xs text-white/20 hover:text-white/50 transition-colors duration-200"
						>
							<GitHubIcon className="w-3.5 h-3.5" />
							Star on GitHub
						</a>
					</div>
				</div>
			</div>
		</footer>
	);
}
