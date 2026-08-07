/**
 * Receipt-field formatters. Costs on receipts are denominated in usertokens;
 * on the usd-proxy basis 1 usertoken = $0.0001 (schema: receipt.v1, `cost`).
 */
const UT_PER_USD = 10_000;

export function formatUsertokens(n: number): string {
	return `${n.toLocaleString("en-US")} ut`;
}

export function usdFromUsertokens(n: number): string {
	const usd = n / UT_PER_USD;
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

export function truncateHash(hash: string): string {
	if (hash.length <= 20) return hash;
	return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function formatTimestamp(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
