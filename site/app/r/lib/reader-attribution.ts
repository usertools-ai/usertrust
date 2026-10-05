/**
 * Rate-limit attribution for the verify page's SERVER-SIDE resolver fetch —
 * the page half of the resolver's `Usertrust-Reader-IP` gate (resolver spec
 * v0.2, "Rate limiting — dedicated reader-IP header with service-key
 * authentication", Cam's ruling 2026-08-10, option (b)).
 *
 * The page fetches the resolver from its own servers, so without this every
 * visitor shares one rate bucket: the site's egress address. The resolver
 * honours `Usertrust-Reader-IP` ONLY alongside `Authorization: Bearer
 * <service key>`, so this module sends the reader IP only with the key.
 *
 * Rules (spec v0.2 + D1):
 * - The key travels in the `Authorization` header and nowhere else (never a
 *   query string, never a cookie). It is a rate-limit attribution credential,
 *   not an access credential: without it, the resolver still answers.
 * - The reader IP is the PLATFORM-ATTESTED client IP, never a header the
 *   visitor controls. On Vercel that is `x-vercel-forwarded-for`, which
 *   Vercel sets itself. Its docs: "we currently overwrite the X-Forwarded-For
 *   header and do not forward external IPs ... to prevent IP spoofing";
 *   `x-vercel-forwarded-for` "is identical to the x-forwarded-for header.
 *   However, x-forwarded-for could be overwritten if you're using a proxy on
 *   top of Vercel". So `x-forwarded-for` and `x-real-ip` are deliberately NOT
 *   read here.
 * - Malformed means unsent. A value that is not one IP literal is dropped,
 *   and the key alone puts the request in the resolver's keyed page-service
 *   floor. That is never a rejection.
 */
import { isIP } from "node:net";

/** Server-only. Never exposed to the client bundle (no `NEXT_PUBLIC_` prefix). */
export const SERVICE_KEY_ENV = "USERTRUST_RESOLVER_SERVICE_KEY";

/** The resolver ignores keys shorter than this, so the page doesn't send them. */
export const MIN_SERVICE_KEY_LENGTH = 32;

/** The header Vercel itself sets to the visitor's public IP. */
export const PLATFORM_CLIENT_IP_HEADER = "x-vercel-forwarded-for";

export function serviceKeyFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const key = env[SERVICE_KEY_ENV]?.trim();
	return key !== undefined && key.length >= MIN_SERVICE_KEY_LENGTH ? key : undefined;
}

/**
 * The visitor's platform-attested IP, or `undefined` when absent or malformed.
 * One value only: a comma-separated list is malformed, not "take the first".
 */
export function readerIpFromPlatformHeaders(headers: {
	get(name: string): string | null;
}): string | undefined {
	const raw = headers.get(PLATFORM_CLIENT_IP_HEADER);
	if (raw === null || raw.includes(",")) return undefined;
	const ip = raw.trim();
	if (ip.length === 0 || ip.length > 45 || isIP(ip) === 0) return undefined;
	return ip;
}

/**
 * The headers the resolver fetch adds. No key → nothing (an unauthenticated
 * reader IP would be ignored by the resolver anyway). Key but no valid reader
 * IP → the key alone (the keyed page-service floor).
 */
export function resolverAttributionHeaders(
	serviceKey: string | undefined,
	readerIp: string | undefined,
): Record<string, string> {
	if (serviceKey === undefined || serviceKey.length < MIN_SERVICE_KEY_LENGTH) return {};
	const headers: Record<string, string> = { Authorization: `Bearer ${serviceKey}` };
	if (readerIp !== undefined && isIP(readerIp) !== 0) headers["Usertrust-Reader-IP"] = readerIp;
	return headers;
}
