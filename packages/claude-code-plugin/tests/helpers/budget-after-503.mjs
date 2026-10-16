// A test preload for PreToolUse, with `--import`: once an authorize is answered 503, the hook's
// clock (Date.now) moves on so that UT_CC_TEST_LEFT_AFTER_503 ms of its 10 s budget are left, as if
// the call had taken that long. The budget counts from launch.mjs's start, which follows this
// preload's own load by a few milliseconds, so what is left is that figure plus those few.
const left = Number(process.env.UT_CC_TEST_LEFT_AFTER_503);
const loadedAt = Date.now();
const realNow = Date.now.bind(Date);
const realFetch = globalThis.fetch;
let moved = false;

globalThis.fetch = async (url, init) => {
	const response = await realFetch(url, init);
	if (!moved && String(url).includes("/v1/authorize") && response.status === 503) {
		moved = true;
		const offset = loadedAt + 10_000 - left - realNow();
		Date.now = () => realNow() + offset;
	}
	return response;
};
