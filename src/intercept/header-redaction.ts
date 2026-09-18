import type { IncomingHttpHeaders } from "http";

export const SENSITIVE_HEADER_PARTS = [
	"authorization",
	"x-api-key",
	"x-auth-token",
	"cookie",
	"set-cookie",
	"x-session-token",
	"x-access-token",
	"bearer",
	"proxy-authorization",
];

type HeaderMap = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

/** Flatten headers and fully redact credentials unless explicitly requested. */
export function processHeaders(
	headers: HeaderMap,
	includeSensitiveHeaders: boolean = false,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const stringValue = Array.isArray(value) ? value.join(", ") : String(value);
		const sensitive = SENSITIVE_HEADER_PARTS.some((part) =>
			key.toLowerCase().includes(part),
		);
		result[key] = sensitive && !includeSensitiveHeaders ? "[REDACTED]" : stringValue;
	}
	return result;
}
