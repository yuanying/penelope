import type http from "node:http";

/**
 * What one check makes of a call: the ServiceAccount it is
 * (`system:serviceaccount:<namespace>:<name>`), refused, or no answer to be had
 * (the API server or gated's keys out of reach). Only the first lets it in.
 */
export type Verdict = { kind: "subject"; subject: string } | { kind: "refused"; reason: string } | { kind: "unavailable"; reason: string };

/**
 * One way of checking a sender, chosen by the settings. A call is decided by
 * the check whose header it carries; when it carries more than one, by the
 * check with the lowest `precedence`.
 */
export interface SenderCheck {
  readonly name: string;
  readonly precedence: number;
  carries(headers: http.IncomingHttpHeaders): boolean;
  check(headers: http.IncomingHttpHeaders): Promise<Verdict>;
}

export type Identity = { kind: "subject"; subject: string; check: string } | Exclude<Verdict, { kind: "subject" }>;

export async function identify(checks: readonly SenderCheck[], headers: http.IncomingHttpHeaders): Promise<Identity> {
  const check = [...checks].sort((a, b) => a.precedence - b.precedence).find((each) => each.carries(headers));
  if (check === undefined) return { kind: "refused", reason: "no credential any check reads" };
  const verdict = await check.check(headers);
  return verdict.kind === "subject" ? { ...verdict, check: check.name } : { ...verdict, reason: `${check.name}: ${verdict.reason}` };
}

/** The token of `Authorization: Bearer <token>`, or undefined. */
export function bearerOf(headers: http.IncomingHttpHeaders): string | undefined {
  return /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(headers.authorization ?? "")?.[1];
}
