// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust completions <shell> — Output shell completion scripts
 *
 * Outputs completion scripts for bash, zsh, or fish to stdout.
 * Follow the standard pattern used by kubectl, docker, gh, etc.
 *
 * Usage:
 *   usertrust completions bash
 *   usertrust completions zsh
 *   usertrust completions fish
 */

import type { CliOptions } from "./init.js";

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

function bashScript(): string {
	return `# bash completion for usertrust
# Install: usertrust completions bash >> ~/.bashrc
# Or:      usertrust completions bash > /etc/bash_completion.d/usertrust

_usertrust() {
    local cur prev commands global_flags
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    commands="init inspect health verify snapshot tb completions"
    global_flags="--json --help"

    case "\${prev}" in
        snapshot)
            COMPREPLY=( $(compgen -W "create restore list" -- "\${cur}") )
            return 0
            ;;
        tb)
            COMPREPLY=( $(compgen -W "start stop status" -- "\${cur}") )
            return 0
            ;;
        completions)
            COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
            return 0
            ;;
        usertrust)
            COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
            return 0
            ;;
    esac

    if [[ "\${cur}" == -* ]]; then
        COMPREPLY=( $(compgen -W "\${global_flags}" -- "\${cur}") )
        return 0
    fi

    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
}

complete -F _usertrust usertrust
`;
}

function zshScript(): string {
	return `#compdef usertrust
# zsh completion for usertrust
# Install: usertrust completions zsh > ~/.zsh/completions/_usertrust
# Then add to .zshrc: fpath=(~/.zsh/completions $fpath); autoload -Uz compinit; compinit

_usertrust() {
    local -a commands
    commands=(
        'init:Initialize trust vault'
        'inspect:Show trust bank statement'
        'health:Show entropy diagnostics'
        'verify:Verify audit chain integrity'
        'snapshot:Create/restore vault snapshots'
        'tb:Manage TigerBeetle process'
        'completions:Output shell completion scripts'
    )

    local -a global_flags
    global_flags=(
        '--json[Output machine-readable JSON]'
        '--help[Show help]'
    )

    _arguments -C \\
        '1:command:->command' \\
        '*::arg:->args'

    case "\$state" in
        command)
            _describe 'usertrust command' commands
            _values 'flags' \${global_flags}
            ;;
        args)
            case "\${words[1]}" in
                snapshot)
                    local -a snapshot_cmds
                    snapshot_cmds=('create:Create a snapshot' 'restore:Restore a snapshot' 'list:List snapshots')
                    _describe 'snapshot subcommand' snapshot_cmds
                    ;;
                tb)
                    local -a tb_cmds
                    tb_cmds=('start:Start TigerBeetle' 'stop:Stop TigerBeetle' 'status:Show TigerBeetle status')
                    _describe 'tb subcommand' tb_cmds
                    ;;
                completions)
                    local -a shells
                    shells=('bash:Bash completion' 'zsh:Zsh completion' 'fish:Fish completion')
                    _describe 'shell' shells
                    ;;
            esac
            ;;
    esac
}

compdef _usertrust usertrust
`;
}

function fishScript(): string {
	return `# fish completion for usertrust
# Install: usertrust completions fish > ~/.config/fish/completions/usertrust.fish

# Disable file completions
complete -c usertrust -f

# Commands
complete -c usertrust -n '__fish_use_subcommand' -a init -d 'Initialize trust vault'
complete -c usertrust -n '__fish_use_subcommand' -a inspect -d 'Show trust bank statement'
complete -c usertrust -n '__fish_use_subcommand' -a health -d 'Show entropy diagnostics'
complete -c usertrust -n '__fish_use_subcommand' -a verify -d 'Verify audit chain integrity'
complete -c usertrust -n '__fish_use_subcommand' -a snapshot -d 'Create/restore vault snapshots'
complete -c usertrust -n '__fish_use_subcommand' -a tb -d 'Manage TigerBeetle process'
complete -c usertrust -n '__fish_use_subcommand' -a completions -d 'Output shell completion scripts'

# Global flags
complete -c usertrust -l json -d 'Output machine-readable JSON'
complete -c usertrust -l help -d 'Show help'

# snapshot subcommands
complete -c usertrust -n '__fish_seen_subcommand_from snapshot' -a create -d 'Create a snapshot'
complete -c usertrust -n '__fish_seen_subcommand_from snapshot' -a restore -d 'Restore a snapshot'
complete -c usertrust -n '__fish_seen_subcommand_from snapshot' -a list -d 'List snapshots'

# tb subcommands
complete -c usertrust -n '__fish_seen_subcommand_from tb' -a start -d 'Start TigerBeetle'
complete -c usertrust -n '__fish_seen_subcommand_from tb' -a stop -d 'Stop TigerBeetle'
complete -c usertrust -n '__fish_seen_subcommand_from tb' -a status -d 'Show TigerBeetle status'

# completions subcommands
complete -c usertrust -n '__fish_seen_subcommand_from completions' -a bash -d 'Bash completion'
complete -c usertrust -n '__fish_seen_subcommand_from completions' -a zsh -d 'Zsh completion'
complete -c usertrust -n '__fish_seen_subcommand_from completions' -a fish -d 'Fish completion'
`;
}

function isShell(value: string): value is Shell {
	return SHELLS.includes(value as Shell);
}

function getScript(shell: Shell): string {
	switch (shell) {
		case "bash":
			return bashScript();
		case "zsh":
			return zshScript();
		case "fish":
			return fishScript();
	}
}

function printUsage(): void {
	console.log(`Usage: usertrust completions <shell>

Generate shell completion scripts.

Shells:
  bash    Bash completion script
  zsh     Zsh completion script
  fish    Fish completion script

Examples:
  usertrust completions bash >> ~/.bashrc
  usertrust completions zsh > ~/.zsh/completions/_usertrust
  usertrust completions fish > ~/.config/fish/completions/usertrust.fish`);
}

export async function run(shell?: string, opts?: CliOptions): Promise<void> {
	const json = opts?.json === true;

	if (!shell || !isShell(shell)) {
		if (json) {
			console.log(
				JSON.stringify({
					command: "completions",
					success: false,
					data: {
						message: shell ? `Unknown shell: ${shell}` : "No shell specified",
						shells: [...SHELLS],
					},
				}),
			);
		} else {
			printUsage();
		}
		return;
	}

	const script = getScript(shell);

	if (json) {
		console.log(
			JSON.stringify({
				command: "completions",
				success: true,
				data: { shell, script },
			}),
		);
	} else {
		process.stdout.write(script);
	}
}
