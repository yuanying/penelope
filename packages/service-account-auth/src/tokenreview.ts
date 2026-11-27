// The `tokenreview` check (ADR-0010, docs/a2a.md): the sender's ServiceAccount
// token, from `Authorization: Bearer`, reviewed by the cluster's API server
// with the backend's own ServiceAccount token.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

import { bearerOf, type SenderCheck, type Verdict } from "./senders.ts";

export const TOKEN_REVIEW_PATH = "/apis/authentication.k8s.io/v1/tokenreviews";
const TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 1024 * 1024;

/** Where the API server is and how the backend calls it: in the cluster, its own projected token and the cluster's CA. */
export type KubernetesSettings = {
  /** `https://host:port`. */
  url: string;
  /** The backend's ServiceAccount token, read again for every review: the kubelet rotates it. */
  tokenFile: string;
  /** The CA that signed the API server's certificate, PEM. Without it, the system's. */
  ca?: string;
};

export class TokenReview implements SenderCheck {
  readonly name = "tokenreview";
  readonly precedence = 1;
  private readonly kubernetes: KubernetesSettings;
  private readonly audiences: readonly string[];

  /** `audiences` are those a token must be for; none leaves it to the API server's own. */
  constructor(kubernetes: KubernetesSettings, audiences: readonly string[]) {
    this.kubernetes = kubernetes;
    this.audiences = audiences;
  }

  carries(headers: http.IncomingHttpHeaders): boolean {
    return bearerOf(headers) !== undefined;
  }

  async check(headers: http.IncomingHttpHeaders): Promise<Verdict> {
    const token = bearerOf(headers);
    if (token === undefined) return { kind: "refused", reason: "no bearer token" };
    let answer: { status: number; body: unknown };
    try {
      answer = await this.review(token);
    } catch (error) {
      return { kind: "unavailable", reason: `the API server did not answer: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (answer.status !== 200 && answer.status !== 201) return { kind: "unavailable", reason: `the API server answered ${answer.status}` };
    const status = (answer.body as { status?: { authenticated?: unknown; user?: { username?: unknown }; audiences?: unknown } } | null)?.status;
    if (status?.authenticated !== true) return { kind: "refused", reason: "the token is not authenticated" };
    const username = status.user?.username;
    if (typeof username !== "string") return { kind: "refused", reason: "the review names no user" };
    // A review that names audiences answers with those the token is for; one of them must be ours.
    if (this.audiences.length > 0) {
      const granted = Array.isArray(status.audiences) ? status.audiences : [];
      if (!granted.some((audience) => this.audiences.includes(audience as string))) return { kind: "refused", reason: "the token is for none of the audiences" };
    }
    return { kind: "subject", subject: username };
  }

  private review(token: string): Promise<{ status: number; body: unknown }> {
    const own = readFileSync(this.kubernetes.tokenFile, "utf8").trim();
    const body = JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token, ...(this.audiences.length === 0 ? {} : { audiences: this.audiences }) },
    });
    const url = new URL(TOKEN_REVIEW_PATH, this.kubernetes.url);
    const client = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request(
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${own}`, "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(body) },
          timeout: TIMEOUT_MS,
          ...(this.kubernetes.ca === undefined ? {} : { ca: this.kubernetes.ca }),
        },
        (response) => {
          const parts: Buffer[] = [];
          let size = 0;
          response.on("data", (part: Buffer) => {
            size += part.length;
            if (size > MAX_ANSWER_BYTES) request.destroy(new Error("the answer is too long"));
            else parts.push(part);
          });
          response.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
            } catch {
              parsed = undefined;
            }
            resolve({ status: response.statusCode ?? 0, body: parsed });
          });
          response.on("error", reject);
        },
      );
      request.on("timeout", () => request.destroy(new Error("timed out")));
      request.on("error", reject);
      request.end(body);
    });
  }
}
