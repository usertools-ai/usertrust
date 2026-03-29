import { GitHubIcon } from "./github-icon";

export function Nav() {
	return (
		<nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-brand-bg/80 backdrop-blur-[16px] border-b border-white/[0.06]">
			<a
				href="/"
				className="inline-flex items-center px-4 py-1.5 border border-white/20 rounded-full font-mono text-sm font-medium tracking-tight hover:border-ut/50 hover:text-ut transition-colors duration-200"
			>
				usertrust
			</a>

			<div className="flex items-center gap-6">
				<div className="hidden md:flex items-center gap-5 text-sm text-white/60 font-medium">
					<a href="#code" className="hover:text-white transition-colors duration-200">
						Code
					</a>
					<a href="#features" className="hover:text-white transition-colors duration-200">
						Features
					</a>
					<a href="#how" className="hover:text-white transition-colors duration-200">
						How it works
					</a>
				</div>

				<a
					href="https://github.com/usertools-ai/usertrust"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-medium hover:bg-white/[0.10] hover:border-white/20 transition-all duration-200"
				>
					<GitHubIcon className="w-4 h-4" />
					GitHub
				</a>
			</div>
		</nav>
	);
}
