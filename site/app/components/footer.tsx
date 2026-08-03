import { GitHubIcon } from "./github-icon";

export function Footer() {
	return (
		<footer className="relative">
			<div className="h-px bg-gradient-to-r from-transparent via-ut/15 to-transparent" />
			<div className="max-w-5xl mx-auto safe-x py-12">
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-10">
					{/* Brand column */}
					<div className="col-span-2 sm:col-span-1 flex flex-col gap-3">
						<span className="font-mono text-ut font-semibold text-sm">usertrust</span>
						<p className="text-xs text-white/30 leading-relaxed max-w-[200px]">
							Financial governance for AI agents. Open source. Apache 2.0.
						</p>
					</div>

					{/*
					 * Link rows are 44px tall for the touch target, and the column carries no
					 * `gap` because those rows already supply the separation — a gap on top of
					 * them stacks two spacings and doubles the footer's height on a phone.
					 *
					 * `items-end`, not `items-center`: `.animated-underline::after` is pinned to
					 * `bottom: -2px` of the anchor box, so centring the label inside a 44px row
					 * strands the hover underline 12px beneath the word it belongs to.
					 */}
					<div className="flex flex-col">
						<span className="text-xs font-medium text-white/50 uppercase tracking-wider">
							Product
						</span>
						<a
							href="#features"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Features
						</a>
						<a
							href="#how"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							How it works
						</a>
						<a
							href="#code"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Quick start
						</a>
						<a
							href="/docs"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							Docs
						</a>
					</div>

					{/* Resources */}
					<div className="flex flex-col">
						<span className="text-xs font-medium text-white/50 uppercase tracking-wider">
							Resources
						</span>
						<a
							href="https://github.com/usertools-ai/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							GitHub
						</a>
						<a
							href="https://www.npmjs.com/package/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							npm
						</a>
						<a
							href="https://github.com/usertools-ai/usertrust/blob/master/LICENSE"
							target="_blank"
							rel="noopener noreferrer"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
						>
							License
						</a>
					</div>

					{/* Company */}
					<div className="flex flex-col">
						<span className="text-xs font-medium text-white/50 uppercase tracking-wider">
							Company
						</span>
						<a
							href="https://usertools.ai"
							target="_blank"
							rel="noopener noreferrer"
							className="focus-ring animated-underline flex min-h-[44px] items-end text-sm text-white/30 hover:text-white/70 transition-colors duration-200"
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
							className="focus-ring text-white/30 hover:text-ut transition-colors duration-200"
						>
							usertools.ai
						</a>
					</p>
					<div className="flex items-center gap-4">
						<a
							href="#top"
							className="focus-ring inline-flex min-h-[44px] items-center text-xs text-white/20 hover:text-ut transition-colors duration-200"
						>
							Back to top ↑
						</a>
						<a
							href="https://github.com/usertools-ai/usertrust"
							target="_blank"
							rel="noopener noreferrer"
							className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 text-xs text-white/20 hover:text-white/50 transition-colors duration-200"
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
