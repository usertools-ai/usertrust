// A test-only preload (`node --import`) for a hook's PARENT: `process.platform` reads
// "win32", so the launcher takes its Windows path on any platform. Nothing else about
// the process changes, and a child gets no node options, so it never sees this.
Object.defineProperty(process, "platform", { value: "win32" });
