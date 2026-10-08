import { execFileSync, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

// The config file (config.mjs): a configured session reads every setting from one
// file inside <passwd home>/.config/usertrust/, and no UT_* variable. The hooks are
// run as Claude Code runs them, with a test-only preload standing in for the passwd
// database's home (helpers/passwd-home.mjs).

const HOOKS = join(import.meta.dirname, "..", "hooks");
const PRE = join(HOOKS, "pre-tool-use.mjs");
const SESSION_START = join(HOOKS, "session-start.mjs");
const PRELOAD = ["--import", join(import.meta.dirname, "helpers", "passwd-home.mjs")];
/** Planted wherever the config file could leak a value; it must never come out. */
const MARKER = "-----BEGIN TEST KEY-----";
/**
 * The part of MARKER every leak would carry. A JSON parse error quotes its input
 * when the bad token is a letter (`Unexpected token 'B', "BEGIN TEST KEY..."`), but
 * not after MARKER's leading dashes, so the marker is also planted letter-first.
 */
const LEAK = "BEGIN TEST";
/** Every form a leak could take: as written, and percent-encoded, as a url prints it. */
const LEAKS = [LEAK, "BEGIN%20TEST"];
const leaks = (text: string) => LEAKS.filter((leak) => text.includes(leak));
/**
 * Every variable that reroutes or exposes a configured session's requests, blank: a
 * shell that sets one (NODE_EXTRA_CA_CERTS is common) must not refuse these tests.
 */
const NO_REROUTE = {
	NODE_USE_ENV_PROXY: "",
	NODE_TLS_REJECT_UNAUTHORIZED: "",
	NODE_EXTRA_CA_CERTS: "",
	NODE_OPTIONS: "",
	SSL_CERT_FILE: "",
	SSL_CERT_DIR: "",
	NODE_USE_SYSTEM_CA: "",
	OPENSSL_CONF: "",
	OPENSSL_MODULES: "",
	OPENSSL_ENGINES: "",
	HTTP_PROXY: "",
	HTTPS_PROXY: "",
};

interface Settings {
	configured: boolean;
	refused: string | null;
	url: string | null;
	key: string;
	mode: string;
	failOpen: boolean;
	stateDir: string;
	usage: string;
	model: string;
	sendContent: boolean;
	unit?: string;
	role?: string;
}

interface ResolveInput {
	env: Record<string, string>;
	passwdHome: string | null;
	uid: number | null;
	execArgv?: string[];
	fs?: Record<string, unknown>;
}

interface ConfigModule {
	resolveSettings(input: ResolveInput): Settings;
}

const REAL_FS = {
	closeSync: nodeFs.closeSync,
	fstatSync: nodeFs.fstatSync,
	lstatSync: nodeFs.lstatSync,
	openSync: nodeFs.openSync,
	readFileSync: nodeFs.readFileSync,
	realpathSync: nodeFs.realpathSync,
};

async function configModule(): Promise<ConfigModule> {
	// @ts-expect-error TS7016: config.mjs ships as plain .mjs, with no type declarations.
	return (await import("../hooks/config.mjs")) as ConfigModule;
}

/** A Stats as it is, but owned by another user. */
function ownedByAnother(stats: nodeFs.Stats): nodeFs.Stats {
	const copy = Object.create(Object.getPrototypeOf(stats) as object) as nodeFs.Stats;
	return Object.assign(copy, stats, { uid: stats.uid + 1 });
}

const UID = process.getuid?.() ?? null;

interface Home {
	home: string;
	anchor: string;
}

/** A passwd home (its real path: no symlinked component) holding the config anchor, 0700. */
async function makeHome(): Promise<Home> {
	const home = nodeFs.realpathSync(await mkdtemp(join(tmpdir(), "utcc-home-")));
	const anchor = join(home, ".config", "usertrust");
	await mkdir(anchor, { recursive: true });
	await chmod(anchor, 0o700);
	return { home, anchor };
}

/** A config file: JSON for an object, verbatim for a string; 0600 unless told. */
async function writeConfig(path: string, content: unknown, mode = 0o600): Promise<string> {
	await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
	await chmod(path, mode);
	return path;
}

const VALID = {
	url: "http://127.0.0.1:9",
	key: "file-key",
	mode: "watch",
	stateDir: "/tmp/utcc-state",
};

/** Every refusal is one of these fixed forms: our own field names, never a value. */
const REASON =
	/^config: (empty|unreadable|not valid JSON|outside the anchor|anchor refused \((home|missing|symlink|type|owner|mode)\)|file refused \((symlink|type|owner|mode|size)\)|field "[A-Za-z]+" (missing|invalid)|environment refused \((NODE_USE_ENV_PROXY|NODE_OPTIONS|--use-env-proxy|--use-openssl-ca|--use-system-ca|--openssl-config|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_USE_SYSTEM_CA|OPENSSL_CONF|OPENSSL_MODULES|OPENSSL_ENGINES)\))$/;

describe("resolveSettings: which file a configured session accepts", () => {
	const resolve = async (
		home: Home,
		path: string,
		{ fs = REAL_FS, uid = UID }: { fs?: Record<string, unknown>; uid?: number | null } = {},
	) => {
		const { resolveSettings } = await configModule();
		return resolveSettings({ env: { UT_CC_CONFIG: path }, passwdHome: home.home, uid, fs });
	};

	it("accepts a 0600 file of the user's inside the anchor, with every field as given", async () => {
		const home = await makeHome();
		const path = await writeConfig(join(home.anchor, "session.json"), {
			...VALID,
			failOpen: true,
			sendContent: false,
			usage: "estimate",
			model: "file-model",
			unit: "file-unit",
			role: "file-role",
		});
		const settings = await resolve(home, path);
		expect(settings).toMatchObject({
			configured: true,
			refused: null,
			url: VALID.url,
			key: "file-key",
			mode: "watch",
			failOpen: true,
			stateDir: VALID.stateDir,
			usage: "estimate",
			model: "file-model",
			sendContent: false,
			unit: "file-unit",
			role: "file-role",
		});
		// The optional fields' defaults, when absent.
		await writeConfig(path, VALID);
		expect(await resolve(home, path)).toMatchObject({
			failOpen: false,
			sendContent: true,
			usage: "transcript",
			model: "claude-sonnet-4-6",
		});
		const absent = await resolve(home, path);
		expect(absent.unit).toBeUndefined();
		expect(absent.role).toBeUndefined();
	});

	it("is unconfigured, and reads the environment, only when UT_CC_CONFIG is absent", async () => {
		const { resolveSettings } = await configModule();
		const env = { UT_SERVER_URL: "http://env", UT_SERVER_KEY: "env-key", UT_CC_MODE: "enforce" };
		expect(resolveSettings({ env, passwdHome: null, uid: UID })).toMatchObject({
			configured: false,
			url: "http://env",
			key: "env-key",
			mode: "enforce",
		});
		// Present but empty is configured: refused, never the environment.
		expect(
			resolveSettings({ env: { ...env, UT_CC_CONFIG: "" }, passwdHome: null, uid: UID }),
		).toMatchObject({
			configured: true,
			refused: "config: empty",
			url: null,
			key: "",
			mode: "watch",
		});
	});

	it("refuses a file outside the anchor: elsewhere, through `..`, or a bare name", async () => {
		const home = await makeHome();
		await mkdir(join(home.home, "elsewhere"));
		const outside = await writeConfig(join(home.home, "elsewhere", "session.json"), VALID);
		expect((await resolve(home, outside)).refused).toBe("config: outside the anchor");
		const dotdot = join(home.anchor, "..", "..", "elsewhere", "session.json");
		expect((await resolve(home, dotdot)).refused).toBe("config: outside the anchor");
		// A sibling directory whose name starts with the anchor's is outside it too.
		await mkdir(`${home.anchor}-other`);
		const sibling = await writeConfig(join(`${home.anchor}-other`, "session.json"), VALID);
		expect((await resolve(home, sibling)).refused).toBe("config: outside the anchor");
		// A bare name would resolve against the cwd, which is outside the anchor.
		await writeConfig(join(home.anchor, "session.json"), VALID);
		expect((await resolve(home, "session.json")).refused).toBe("config: outside the anchor");
		// Control: the same file, named by its path in the anchor, is accepted.
		expect((await resolve(home, join(home.anchor, "session.json"))).refused).toBeNull();
	});

	it("refuses an anchor with a symlinked component, a missing one, or one that is not a directory", async () => {
		const home = await makeHome();
		const path = await writeConfig(join(home.anchor, "session.json"), VALID);
		expect((await resolve(home, path)).refused).toBeNull();
		// ~/.config made a link to a directory holding the same anchor and file.
		const real = join(home.home, "real-config");
		await mkdir(join(real, "usertrust"), { recursive: true });
		await chmod(join(real, "usertrust"), 0o700);
		await writeConfig(join(real, "usertrust", "session.json"), VALID);
		nodeFs.rmSync(join(home.home, ".config"), { recursive: true });
		await symlink(real, join(home.home, ".config"));
		expect((await resolve(home, path)).refused).toBe("config: anchor refused (symlink)");
		const bare = await makeHome();
		nodeFs.rmSync(bare.anchor, { recursive: true });
		expect((await resolve(bare, join(bare.anchor, "session.json"))).refused).toBe(
			"config: anchor refused (missing)",
		);
		await writeFile(bare.anchor, "not a directory");
		expect((await resolve(bare, join(bare.anchor, "session.json"))).refused).toBe(
			"config: anchor refused (type)",
		);
		const { resolveSettings } = await configModule();
		expect(
			resolveSettings({ env: { UT_CC_CONFIG: path }, passwdHome: null, uid: UID }).refused,
		).toBe("config: anchor refused (home)");
	});

	it.skipIf(UID === null)(
		"refuses an anchor or a file another user owns, or that others can write or read",
		async () => {
			const home = await makeHome();
			const path = await writeConfig(join(home.anchor, "session.json"), VALID);
			expect((await resolve(home, path)).refused).toBeNull();
			const anchorOfAnother = {
				...REAL_FS,
				lstatSync: (p: nodeFs.PathLike) => {
					const stats = nodeFs.lstatSync(p);
					return p === home.anchor ? ownedByAnother(stats) : stats;
				},
			};
			expect((await resolve(home, path, { fs: anchorOfAnother })).refused).toBe(
				"config: anchor refused (owner)",
			);
			const fileOfAnother = {
				...REAL_FS,
				fstatSync: (fd: number) => ownedByAnother(nodeFs.fstatSync(fd)),
			};
			expect((await resolve(home, path, { fs: fileOfAnother })).refused).toBe(
				"config: file refused (owner)",
			);
			await chmod(home.anchor, 0o770);
			expect((await resolve(home, path)).refused).toBe("config: anchor refused (mode)");
			await chmod(home.anchor, 0o700);
			for (const mode of [0o644, 0o640, 0o604, 0o660]) {
				await chmod(path, mode);
				expect((await resolve(home, path)).refused, mode.toString(8)).toBe(
					"config: file refused (mode)",
				);
			}
		},
	);

	it("refuses a file that is a link, a directory or a FIFO, and one too large", async () => {
		const home = await makeHome();
		const target = await writeConfig(join(home.anchor, "target.json"), VALID);
		const link = join(home.anchor, "link.json");
		await symlink(target, link);
		expect((await resolve(home, link)).refused).toBe("config: file refused (symlink)");
		await mkdir(join(home.anchor, "dir.json"));
		expect((await resolve(home, join(home.anchor, "dir.json"))).refused).toBe(
			"config: file refused (type)",
		);
		const big = await writeConfig(
			join(home.anchor, "big.json"),
			JSON.stringify({ ...VALID, pad: "x".repeat(70 * 1024) }),
		);
		expect((await resolve(home, big)).refused).toBe("config: file refused (size)");
		expect((await resolve(home, join(home.anchor, "absent.json"))).refused).toBe(
			"config: unreadable",
		);
	});

	it("refuses a FIFO without waiting on it (a hook that waited would never finish)", async () => {
		const home = await makeHome();
		const fifo = join(home.anchor, "fifo.json");
		execFileSync("mkfifo", ["-m", "600", fifo]);
		// In a child, bounded: an open that waits for a writer blocks the whole process.
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !name.startsWith("UT_")),
		);
		const start = spawnSync(process.execPath, [...PRELOAD, SESSION_START], {
			input: "{}",
			env: { ...inherited, ...NO_REROUTE, TEST_PASSWD_HOME: home.home, UT_CC_CONFIG: fifo },
			encoding: "utf-8",
			timeout: 10_000,
		});
		expect(start.error, "SessionStart waited on the FIFO").toBeUndefined();
		const line = (JSON.parse(start.stdout) as { systemMessage: string }).systemMessage;
		expect(line).toContain("(config: file refused (type))");
	});

	it("refuses content without a required field, or with a field that is invalid", async () => {
		const home = await makeHome();
		const path = join(home.anchor, "session.json");
		const refusal = async (content: unknown) => {
			await writeConfig(path, content);
			return (await resolve(home, path)).refused;
		};
		for (const text of ["{", "", "[]", "null", "42", '"watch"']) {
			expect(await refusal(text), text).toBe("config: not valid JSON");
		}
		for (const field of ["url", "key", "mode", "stateDir"] as const) {
			const { [field]: _dropped, ...rest } = VALID;
			expect(await refusal(rest), field).toBe(`config: field "${field}" missing`);
		}
		const invalid: Array<[string, unknown]> = [
			["url", "ftp://127.0.0.1"],
			["url", "not a url"],
			["url", 4519],
			["key", ""],
			["key", "has a space"],
			["key", "line\nbreak"],
			["key", 7],
			["mode", "block"],
			["mode", "Enforce"],
			["mode", true],
			["stateDir", "relative/dir"],
			["stateDir", 1],
			["failOpen", "1"],
			["sendContent", "0"],
			["usage", "both"],
			["model", ""],
			["model", "two words"],
			["unit", 5],
			["role", { name: "x" }],
		];
		for (const [field, value] of invalid) {
			expect(await refusal({ ...VALID, [field]: value }), `${field}=${String(value)}`).toBe(
				`config: field "${field}" invalid`,
			);
		}
		// Fields it does not know are ignored.
		expect(await refusal({ ...VALID, comment: "anything" })).toBeNull();
	});

	it("never carries a value from the file in a refusal: the marker as JSON, a field, the mode, the url", async () => {
		const home = await makeHome();
		const path = join(home.anchor, "session.json");
		const placements: unknown[] = [
			`${MARKER}\nnot json`,
			"BEGIN TEST KEY-----\n",
			'{"mode": BEGIN TEST KEY}',
			{ ...VALID, mode: MARKER },
			{ ...VALID, url: MARKER },
			{ ...VALID, url: `ftp://${MARKER}` },
			// A url with credentials: a fetch refuses it with an error that quotes it.
			{ ...VALID, url: "http://operator:BEGIN TEST KEY@127.0.0.1:9" },
			{ ...VALID, url: "https://BEGIN%20TEST@127.0.0.1:9" },
			{ ...VALID, key: `${MARKER}` },
			{ ...VALID, stateDir: MARKER },
		];
		for (const content of placements) {
			await writeConfig(path, content);
			const settings = await resolve(home, path);
			// stringMatching, not toMatch: an accepted file (refused null) fails as an assertion.
			expect(settings.refused, JSON.stringify(content)).toEqual(expect.stringMatching(REASON));
			expect(leaks(JSON.stringify(settings))).toEqual([]);
		}
		// In an unknown field of a valid file it is ignored, and so never anywhere.
		await writeConfig(path, { ...VALID, note: MARKER });
		const valid = await resolve(home, path);
		expect(valid.refused).toBeNull();
		expect(leaks(JSON.stringify(valid))).toEqual([]);
	});

	it("refuses an environment that reroutes the requests or loosens their TLS, each by name", async () => {
		const home = await makeHome();
		const path = await writeConfig(join(home.anchor, "session.json"), VALID);
		const { resolveSettings } = await configModule();
		const refusal = (env: Record<string, string>, execArgv: string[] = []) =>
			resolveSettings({
				env: { UT_CC_CONFIG: path, ...env },
				passwdHome: home.home,
				uid: UID,
				execArgv,
			}).refused;
		// Control: the same file, in a plain environment, is accepted.
		expect(refusal({})).toBeNull();
		const refused: Array<[string, Record<string, string>, string[]]> = [
			["NODE_USE_ENV_PROXY", { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:9" }, []],
			["NODE_TLS_REJECT_UNAUTHORIZED", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, []],
			// Each variable that changes what TLS trusts, alone: SSL_CERT_* need no flag on a
			// build whose default store is OpenSSL's (B-67).
			["NODE_EXTRA_CA_CERTS", { NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" }, []],
			["SSL_CERT_FILE", { SSL_CERT_FILE: "/tmp/ca.pem" }, []],
			["SSL_CERT_DIR", { SSL_CERT_DIR: "/tmp/certs" }, []],
			["NODE_USE_SYSTEM_CA", { NODE_USE_SYSTEM_CA: "1" }, []],
			["OPENSSL_CONF", { OPENSSL_CONF: "/tmp/openssl.cnf" }, []],
			["OPENSSL_MODULES", { OPENSSL_MODULES: "/tmp/modules" }, []],
			["OPENSSL_ENGINES", { OPENSSL_ENGINES: "/tmp/engines" }, []],
			// The hook's own command line, in every spelling Node accepts (B-66).
			["--use-env-proxy", {}, ["--use-env-proxy"]],
			["--use-env-proxy", {}, ["--use_env_proxy"]],
			["--use-openssl-ca", {}, ["--use_openssl_ca"]],
			["--use-system-ca", {}, ["--use-system-ca"]],
			["--openssl-config", {}, ['"--openssl-config=/tmp/x.cnf"']],
		];
		for (const [name, env, execArgv] of refused) {
			expect(refusal(env, execArgv), name).toBe(`config: environment refused (${name})`);
		}
		// NODE_OPTIONS holds only allowlisted tokens (B-66): every spelling Node accepts for a
		// flag that is not on the list is refused, quoted, escaped, `_` for `-`, with `=`, or
		// a `--no-` form (the safe direction).
		for (const options of [
			'"--use-env-proxy"',
			'"--use-env\\-proxy"',
			"--use_env_proxy",
			"--use-env-proxy=1",
			"--max-old-space-size=64 --use-env-proxy",
			'"--use-openssl-ca"',
			"--use_openssl_ca",
			"--use-openssl-ca=true",
			"--no-use-env-proxy",
			"--use-system-ca",
			"--require /tmp/preload.cjs",
			'--max-old-space-size=64"--use-env-proxy"',
		]) {
			expect(refusal({ NODE_OPTIONS: options }), options).toBe(
				"config: environment refused (NODE_OPTIONS)",
			);
		}
		// What neither routes a request nor changes the trust: accepted.
		for (const [env, execArgv] of [
			[{ NODE_USE_ENV_PROXY: "" }, []],
			[{ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" }, []],
			[{ NODE_TLS_REJECT_UNAUTHORIZED: "1" }, []],
			[{ NODE_OPTIONS: "  --max-old-space-size=64   --enable-source-maps --no-warnings " }, []],
			[{ NODE_OPTIONS: "--unhandled-rejections=strict --dns-result-order=ipv4first" }, []],
			[{}, ["--import", "/tmp/a-test-preload.mjs"]],
		] as Array<[Record<string, string>, string[]]>) {
			expect(refusal(env, execArgv), JSON.stringify([env, execArgv])).toBeNull();
		}
	});
});

// ── The hooks, configured ──

interface Seen {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

interface Fake {
	url: string;
	seen: Seen[];
}

const servers: Server[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});

/**
 * A usertrust server that records every request and answers authorize with
 * `status` (a hold for 200). Its health advertises a principal, so one is sent.
 */
function fakeServer(status = 200): Promise<Fake> {
	const seen: Seen[] = [];
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
				res.writeHead(req.url === "/v1/health" ? 200 : status, {
					"content-type": "application/json",
				});
				res.end(
					JSON.stringify(
						req.url === "/v1/health"
							? { status: "ok", capabilities: ["principal"] }
							: status === 200
								? { transferId: "tx_1", estimatedCost: 1, model: "m", createdAt: 1 }
								: { error: "insufficient_budget", reason: "over budget" },
					),
				);
			});
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ url: `http://127.0.0.1:${port}`, seen });
		});
	});
}

interface Proxy {
	url: string;
	/** Each request that reached the proxy: a CONNECT's target, or an absolute-form request line. */
	reached: string[];
	/** Every byte tunnelled or sent to it. */
	bytes: () => string;
}

/**
 * A recording HTTP proxy: it accepts a CONNECT tunnel (how Node's own proxy support
 * carries a request) or an absolute-form request, keeps what it is sent, and answers 503.
 */
function recordingProxy(): Promise<Proxy> {
	const reached: string[] = [];
	let bytes = "";
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			reached.push(`${req.method} ${req.url}`);
			bytes += JSON.stringify(req.headers);
			res.writeHead(503);
			res.end();
		});
		server.on("connect", (req, socket) => {
			reached.push(`CONNECT ${req.url}`);
			socket.on("error", () => {});
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			socket.on("data", (chunk) => {
				bytes += chunk;
				if (bytes.includes("\r\n\r\n"))
					socket.end("HTTP/1.1 503 Unavailable\r\ncontent-length: 0\r\n\r\n");
			});
		});
		servers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ url: `http://127.0.0.1:${port}`, reached, bytes: () => bytes });
		});
	});
}

const PAYLOAD = {
	session_id: "sess1",
	tool_name: "Bash",
	tool_use_id: "tu_1",
	tool_input: { command: "ls" },
};

interface AuthorizeBody {
	model: string;
	messages: Array<{ content: string }>;
	principal?: { unit?: string; role?: string };
}

const authorizes = (fake: Fake) => fake.seen.filter((s) => s.url === "/v1/authorize");
const authorizeBody = (fake: Fake): AuthorizeBody => {
	const [first] = authorizes(fake);
	expect(first, "no authorize reached the server").toBeDefined();
	return JSON.parse(first?.body ?? "{}") as AuthorizeBody;
};

async function files(dir: string): Promise<string[]> {
	try {
		return await readdir(dir, { recursive: true });
	} catch {
		return [];
	}
}

async function watchRecords(stateDir: string): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8");
		return text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

interface Configured {
	home: Home;
	config: string;
	stateDir: string;
}

/** A passwd home with a valid config of `fields` (merged over a watch-mode baseline). */
async function configured(fields: Record<string, unknown>): Promise<Configured> {
	const home = await makeHome();
	const stateDir = await mkdtemp(join(tmpdir(), "utcc-file-state-"));
	const config = await writeConfig(join(home.anchor, "session.json"), {
		...VALID,
		stateDir,
		...fields,
	});
	return { home, config, stateDir };
}

/** Run a hook as a configured session: the preload's passwd home, UT_CC_CONFIG, and `env`. */
const runConfigured = (
	hook: string,
	l: Configured,
	env: Record<string, string> = {},
	payload = PAYLOAD,
) =>
	runHook(
		hook,
		payload,
		{ ...NO_REROUTE, TEST_PASSWD_HOME: l.home.home, UT_CC_CONFIG: l.config, ...env },
		PRELOAD,
	);

describe("a configured session reads every setting from its file, and none from the environment", () => {
	// Each case: (i) the FILE's value is what the hook sends or writes (so a resolver
	// that ignored the file too would fail), then (ii) a conflicting variable changed nothing.

	it("UT_SERVER_URL: the request goes to the file's url", async () => {
		const [file, env] = [await fakeServer(), await fakeServer()];
		const l = await configured({ url: file.url });
		await runConfigured(PRE, l, { UT_SERVER_URL: env.url });
		expect(authorizes(file)).toHaveLength(1);
		expect(env.seen).toEqual([]);
	});

	it("UT_SERVER_KEY: the bearer is the file's key", async () => {
		const file = await fakeServer();
		const l = await configured({ url: file.url });
		await runConfigured(PRE, l, { UT_SERVER_KEY: "env-key" });
		expect(authorizes(file)[0]?.headers.authorization).toBe("Bearer file-key");
	});

	it("UT_CC_MODE: the file's mode decides, both ways", async () => {
		const file = await fakeServer(402);
		const enforcing = await configured({ url: file.url, mode: "enforce" });
		const blocked = await runConfigured(PRE, enforcing, { UT_CC_MODE: "watch" });
		expect(blocked.stdout).toContain('"permissionDecision":"deny"');
		const watching = await configured({ url: file.url, mode: "watch" });
		const through = await runConfigured(PRE, watching, { UT_CC_MODE: "enforce" });
		expect(through.code).toBe(0);
		expect(through.stdout).toBe("");
		expect((await watchRecords(watching.stateDir)).map((r) => r.kind)).toEqual(["would_block"]);
	});

	it("UT_FAIL_OPEN: the file's failOpen decides what an unreachable server means in enforce", async () => {
		const closed = await configured({ mode: "enforce", failOpen: false });
		const blocked = await runConfigured(PRE, closed, { UT_FAIL_OPEN: "1" });
		expect(blocked.code).toBe(2);
		const open = await configured({ mode: "enforce", failOpen: true });
		const through = await runConfigured(PRE, open, { UT_FAIL_OPEN: "0" });
		expect(through.code).toBe(0);
		expect((await watchRecords(open.stateDir)).map((r) => r.kind)).toEqual(["gap"]);
	});

	it("UT_CC_STATE_DIR, CLAUDE_CONFIG_DIR and HOME: state goes to the file's stateDir, and 0600", async () => {
		const file = await fakeServer();
		const l = await configured({ url: file.url });
		const elsewhere = await mkdtemp(join(tmpdir(), "utcc-env-"));
		await runConfigured(PRE, l, {
			UT_CC_STATE_DIR: join(elsewhere, "state"),
			CLAUDE_CONFIG_DIR: join(elsewhere, "claude"),
			HOME: join(elsewhere, "home"),
		});
		const hold = (await files(l.stateDir)).find((name) => name.endsWith(".tx_1.json"));
		expect(hold).toBe("sess1__main__tu_1.tx_1.json");
		expect(nodeFs.statSync(join(l.stateDir, hold as string)).mode & 0o777).toBe(0o600);
		expect(await files(elsewhere)).toEqual([]);
	});

	it("UT_CC_USAGE: the file's usage decides, both ways", async () => {
		const file = await fakeServer();
		const marker = async (l: Configured) =>
			readFile(join(l.stateDir, "transcripts", "estimate", "sess1__main"), "utf-8");
		const estimating = await configured({ url: file.url, usage: "estimate" });
		await runConfigured(PRE, estimating, { UT_CC_USAGE: "transcript" });
		expect(await marker(estimating)).toBe('"usage": "estimate" in the config file');
		const reading = await configured({ url: file.url, usage: "transcript" });
		await runConfigured(PRE, reading, { UT_CC_USAGE: "estimate" });
		expect(await marker(reading)).toBe("no transcript path");
	});

	it("UT_CC_MODEL: the authorize names the file's model", async () => {
		const file = await fakeServer();
		const l = await configured({ url: file.url, model: "file-model" });
		await runConfigured(PRE, l, { UT_CC_MODEL: "env-model" });
		expect(authorizeBody(file).model).toBe("file-model");
	});

	it("UT_CC_SEND_CONTENT: the file's sendContent decides, both ways", async () => {
		const redacting = await fakeServer();
		await runConfigured(PRE, await configured({ url: redacting.url, sendContent: false }), {
			UT_CC_SEND_CONTENT: "1",
		});
		expect(authorizeBody(redacting).messages[0]?.content).toBe('{"redacted":true}');
		const sending = await fakeServer();
		await runConfigured(PRE, await configured({ url: sending.url, sendContent: true }), {
			UT_CC_SEND_CONTENT: "0",
		});
		expect(authorizeBody(sending).messages[0]?.content).toBe('{"command":"ls"}');
	});

	it("UT_CC_UNIT and UT_CC_ROLE: the principal carries the file's", async () => {
		const file = await fakeServer();
		const l = await configured({ url: file.url, unit: "file-unit", role: "file-role" });
		await runConfigured(PRE, l, { UT_CC_UNIT: "env-unit", UT_CC_ROLE: "env-role" });
		expect(authorizeBody(file).principal).toMatchObject({ unit: "file-unit", role: "file-role" });
		const unset = await fakeServer();
		await runConfigured(PRE, await configured({ url: unset.url }), {
			UT_CC_UNIT: "env-unit",
			UT_CC_ROLE: "env-role",
		});
		const principal = authorizeBody(unset).principal;
		expect(principal?.unit).toBeUndefined();
		expect(principal?.role).toBeUndefined();
	});
});

describe("a refused config: watch-only and key-less, and nothing sent", () => {
	it("an EMPTY UT_CC_CONFIG with a key, a url and enforce in the environment: no request, a gap, no block", async () => {
		const env = await fakeServer();
		const home = await makeHome();
		const run = (hook: string) =>
			runHook(
				hook,
				PAYLOAD,
				{
					...NO_REROUTE,
					TEST_PASSWD_HOME: home.home,
					UT_CC_CONFIG: "",
					UT_SERVER_URL: env.url,
					UT_SERVER_KEY: "env-key",
					UT_CC_MODE: "enforce",
				},
				PRELOAD,
			);
		const start = await run(SESSION_START);
		const line = (JSON.parse(start.stdout) as { systemMessage: string }).systemMessage;
		expect(line).toContain("usertrust: watch-only and key-less");
		expect(line).toContain("(config: empty)");
		const pre = await run(PRE);
		expect(pre.code).toBe(0);
		expect(pre.stdout).toBe("");
		expect(env.seen).toEqual([]);
		const defaultState = join(home.home, ".claude", "usertrust-cc");
		expect(await watchRecords(defaultState)).toMatchObject([
			{ kind: "gap", mode: "watch", reason: "config: empty" },
		]);
	});

	it("a file outside the anchor: the same, with that reason", async () => {
		const env = await fakeServer();
		const home = await makeHome();
		await mkdir(join(home.home, "elsewhere"));
		const outside = await writeConfig(join(home.home, "elsewhere", "session.json"), {
			...VALID,
			url: env.url,
		});
		const pre = await runHook(
			PRE,
			PAYLOAD,
			{ ...NO_REROUTE, TEST_PASSWD_HOME: home.home, UT_CC_CONFIG: outside, UT_SERVER_URL: env.url },
			PRELOAD,
		);
		expect(pre.code).toBe(0);
		expect(env.seen).toEqual([]);
		expect(await watchRecords(join(home.home, ".claude", "usertrust-cc"))).toMatchObject([
			{ kind: "gap", reason: "config: outside the anchor" },
		]);
	});

	it("control: on this node, NODE_USE_ENV_PROXY carries an UNCONFIGURED session's key through HTTP_PROXY", async (ctx) => {
		const target = await fakeServer();
		const proxy = await recordingProxy();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-env-state-"));
		await runHook(PRE, PAYLOAD, {
			...NO_REROUTE,
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: target.url,
			UT_SERVER_KEY: "env-key",
			UT_CC_USAGE: "estimate",
			NODE_USE_ENV_PROXY: "1",
			HTTP_PROXY: proxy.url,
		});
		if (proxy.reached.length === 0) {
			// This node has no env-proxy support: the request went straight to the server.
			// CI must run a node that has it, or this case proves nothing there.
			expect(
				process.env.CI,
				`node ${process.version} has no NODE_USE_ENV_PROXY support`,
			).toBeFalsy();
			ctx.skip();
		}
		expect(proxy.reached[0]).toBe(`CONNECT ${new URL(target.url).host}`);
		expect(proxy.bytes()).toContain("Bearer env-key");
	});

	it("a configured session in an environment with NODE_USE_ENV_PROXY is refused: nothing reaches the proxy or the server", async () => {
		const target = await fakeServer();
		const proxy = await recordingProxy();
		const session = await configured({ url: target.url });
		const pre = await runConfigured(PRE, session, {
			NODE_USE_ENV_PROXY: "1",
			HTTP_PROXY: proxy.url,
			HTTPS_PROXY: proxy.url,
		});
		expect(pre.code).toBe(0);
		expect(proxy.reached).toEqual([]);
		expect(target.seen).toEqual([]);
		expect(await watchRecords(join(session.home.home, ".claude", "usertrust-cc"))).toMatchObject([
			{ kind: "gap", reason: "config: environment refused (NODE_USE_ENV_PROXY)" },
		]);
	});

	// B-66: NODE_OPTIONS='"--use-env-proxy"' — Node strips the quotes and enables the option.
	const QUOTED_PROXY = '"--use-env-proxy"';

	it("control: on this node, a QUOTED --use-env-proxy in NODE_OPTIONS carries an UNCONFIGURED session's key through HTTP_PROXY", async (ctx) => {
		const target = await fakeServer();
		const proxy = await recordingProxy();
		const stateDir = await mkdtemp(join(tmpdir(), "utcc-env-state-"));
		await runHook(PRE, PAYLOAD, {
			...NO_REROUTE,
			UT_CC_STATE_DIR: stateDir,
			UT_SERVER_URL: target.url,
			UT_SERVER_KEY: "env-key",
			UT_CC_USAGE: "estimate",
			NODE_OPTIONS: QUOTED_PROXY,
			HTTP_PROXY: proxy.url,
		});
		if (proxy.reached.length === 0) {
			// This node does not accept --use-env-proxy (it refuses to start, or ignores it).
			// CI must run a node that does, or this case proves nothing there.
			expect(process.env.CI, `node ${process.version} has no --use-env-proxy support`).toBeFalsy();
			ctx.skip();
		}
		expect(proxy.reached[0]).toBe(`CONNECT ${new URL(target.url).host}`);
		expect(proxy.bytes()).toContain("Bearer env-key");
	});

	it("a configured session whose NODE_OPTIONS quotes --use-env-proxy sends nothing to the proxy or the server", async () => {
		const target = await fakeServer();
		const proxy = await recordingProxy();
		const session = await configured({ url: target.url });
		const pre = await runConfigured(PRE, session, {
			NODE_OPTIONS: QUOTED_PROXY,
			HTTP_PROXY: proxy.url,
			HTTPS_PROXY: proxy.url,
		});
		expect(proxy.reached).toEqual([]);
		expect(target.seen).toEqual([]);
		// Where node accepts the option, the hook runs and refuses the environment by name.
		// Where it does not, node itself refuses to start, and nothing runs at all.
		if (pre.code === 0) {
			expect(await watchRecords(join(session.home.home, ".claude", "usertrust-cc"))).toMatchObject([
				{ kind: "gap", reason: "config: environment refused (NODE_OPTIONS)" },
			]);
		}
	});

	it("never echoes the file: the marker reaches no stderr, session-start line, record or request", async () => {
		const placements: Array<[string, string | Record<string, unknown>]> = [
			["the first bytes of a file that is not JSON", `${MARKER}\n{"url": 1}`],
			["a file that is not JSON, whose parse error quotes it", "BEGIN TEST KEY-----\n"],
			["the mode", { mode: MARKER }],
			["an invalid url", { url: `${MARKER}` }],
			["a url with credentials", { url: "http://operator:BEGIN TEST KEY@127.0.0.1:9" }],
			["an unknown field of a valid file", { note: MARKER }],
		];
		for (const [where, content] of placements) {
			const server = await fakeServer();
			const home = await makeHome();
			const stateDir = await mkdtemp(join(tmpdir(), "utcc-file-state-"));
			const config = await writeConfig(
				join(home.anchor, "session.json"),
				typeof content === "string" ? content : { ...VALID, url: server.url, stateDir, ...content },
			);
			const env = {
				...NO_REROUTE,
				TEST_PASSWD_HOME: home.home,
				UT_CC_CONFIG: config,
				UT_SERVER_URL: server.url,
			};
			const outputs = [
				await runHook(SESSION_START, {}, env, PRELOAD),
				await runHook(PRE, PAYLOAD, env, PRELOAD),
			].flatMap((r) => [r.stdout, r.stderr]);
			const records = [
				...(await watchRecords(stateDir)),
				...(await watchRecords(join(home.home, ".claude", "usertrust-cc"))),
			];
			const requests = server.seen.map((s) => `${s.url} ${JSON.stringify(s.headers)} ${s.body}`);
			for (const text of [...outputs, JSON.stringify(records), ...requests]) {
				expect(leaks(text), where).toEqual([]);
			}
			// A refusal's gap carries a fixed reason, whatever the parser's wording.
			for (const record of records) {
				if (typeof record.reason === "string" && record.reason.startsWith("config:")) {
					expect(record.reason, where).toMatch(REASON);
				}
			}
			// Control: the run did produce what was searched.
			expect(outputs.join("").length, where).toBeGreaterThan(0);
		}
	});
});

// ── Q2: the hooks read the environment ONLY through config.mjs ──

/** `process` members a hook may use; anything else (env above all) is config.mjs's alone. */
const PROCESS_MEMBERS = new Set(["stdin", "stdout", "stderr", "pid", "exit", "getuid"]);

interface EnvUse {
	line: number;
	text: string;
}

/**
 * Every way a source reaches the environment, read from its syntax tree (so a
 * comment never counts): any `process` that is not `process.<member>` above
 * (`process.env` in any spelling, an alias, a destructuring), any `globalThis`,
 * and any `UT_` name, in a string, a template or an identifier.
 */
function envUses(file: string, text: string): EnvUse[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const found: EnvUse[] = [];
	const add = (node: ts.Node) =>
		found.push({
			line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
			text: (node.parent ?? node).getText(source).slice(0, 80),
		});
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) {
			const parent = node.parent;
			const isName =
				parent !== undefined &&
				((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
					(ts.isPropertyAssignment(parent) && parent.name === node));
			if (node.text === "process" && !isName) {
				const member =
					parent !== undefined &&
					ts.isPropertyAccessExpression(parent) &&
					parent.expression === node
						? parent.name.text
						: null;
				if (member === null || !PROCESS_MEMBERS.has(member)) add(node);
			}
			if (node.text === "globalThis") add(node);
		}
		const words =
			ts.isIdentifier(node) ||
			ts.isStringLiteralLike(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
				? node.text
				: null;
		if (words !== null && /(?<![A-Za-z0-9_])UT_/.test(words)) add(node);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("the hooks read the environment only through config.mjs (any spelling)", () => {
	it("finds every spelling in a fixture, and nothing in a comment or an allowed member", () => {
		const spellings: Record<string, string> = {
			dot: "const a = process.env.UT_CC_MODE;",
			bracket: 'const a = process.env["X"];',
			"template bracket": "const a = process.env[`X`];",
			destructuring: "const { X } = process.env;",
			alias: "const e = process.env; const a = e.X;",
			"env destructured from process": "const { env } = process; const a = env.X;",
			"env by a computed name": 'const a = process["env"].X;',
			globalThis: "const a = globalThis.process.env.X;",
			"process aliased": "const p = process; const a = p.env.X;",
			// "$" and "{" apart, so this string is not itself read as a template.
			"a UT_ name built from parts": "const name = `UT_$" + "{part}`;",
			"a UT_ name as a string": 'const name = "UT_SERVER_URL";',
		};
		for (const [spelling, text] of Object.entries(spellings)) {
			expect(envUses("fixture.mjs", text).length, spelling).toBeGreaterThan(0);
		}
		const allowed = [
			"process.stderr.write(`x`);",
			"process.exit(2);",
			"const n = process.pid;",
			"// process.env.UT_CC_MODE, in a comment",
			"/* process.env */ const x = MAX_OUTPUT_TOKENS;",
			"const o = { process: 1 }; o.process;",
		].join("\n");
		expect(envUses("fixture.mjs", allowed)).toEqual([]);
	});

	it("no hook but config.mjs reads the environment, and config.mjs does", () => {
		const uses = Object.fromEntries(
			nodeFs
				.readdirSync(HOOKS)
				.filter((name) => name.endsWith(".mjs"))
				.map((name) => [name, envUses(name, nodeFs.readFileSync(join(HOOKS, name), "utf-8"))]),
		);
		const { "config.mjs": inConfig, ...rest } = uses;
		expect(rest).toEqual(Object.fromEntries(Object.keys(rest).map((name) => [name, []])));
		// Control: the scan does see the reads where they are.
		expect(inConfig?.length ?? 0).toBeGreaterThan(0);
	});
});
