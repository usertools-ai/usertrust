// A failpoint for the launcher tests, preloaded into a hook's PARENT with `--import`
// (launch.mjs never passes it on: a child gets no node options). It replaces the spawn
// of a configured session's child (`--ut-child`) by a stand-in, as TEST_SPAWN_FAIL says:
//   emfile    a spawn short of descriptors, as Node gives it: a child with NO stdin, and
//             an `error` (EMFILE) only on a later tick
//   throw     a child whose every listener registration throws: a throw in the parent
//             that nothing foresaw
//   uncaught  a child that never answers, and a throw in a timer: a throw no `catch` can
//             reach
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";

const childProcess = createRequire(import.meta.url)("node:child_process");
const { spawn } = childProcess;
const failure = process.env.TEST_SPAWN_FAIL ?? "";

childProcess.spawn = (file, args, options) => {
	if (!(args ?? []).includes("--ut-child")) return spawn(file, args, options);
	const child = new EventEmitter();
	child.kill = () => true;
	if (failure === "emfile") {
		const err = Object.assign(new Error("spawn EMFILE"), { code: "EMFILE", syscall: "spawn" });
		process.nextTick(() => child.emit("error", err));
	} else if (failure === "throw") {
		child.on = () => {
			throw new TypeError("injected");
		};
		child.once = child.on;
	} else if (failure === "uncaught") {
		setTimeout(() => {
			throw new Error("injected");
		}, 20);
	}
	return child;
};
syncBuiltinESMExports();
