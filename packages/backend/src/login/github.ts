import { GitHubOAuth, refused, type GitHubEndpoints, type GitHubOAuthSettings, type Refused } from "@penelope/github-oauth";

import type { LoginSessions, Session } from "./sessions.ts";

export { CALLBACK_PATH, type GitHubEndpoints } from "@penelope/github-oauth";

export type GitHubSettings = GitHubOAuthSettings & { ownerId: number };
type Finish = { kind: "signed-in"; session: Session } | Refused;

export class GitHubLogin {
  private readonly oauth: GitHubOAuth<undefined>;
  private readonly ownerId: number | undefined;
  private readonly sessions: LoginSessions;
  private readonly log: (line: string) => void;

  constructor(options: {
    settings: GitHubSettings | undefined;
    endpoints?: GitHubEndpoints;
    sessions: LoginSessions;
    now: () => number;
    log?: (line: string) => void;
  }) {
    this.oauth = new GitHubOAuth(options);
    this.ownerId = options.settings?.ownerId;
    this.sessions = options.sessions;
    this.log = options.log ?? console.error;
  }

  start() {
    return this.oauth.start(undefined);
  }

  async callback(query: URLSearchParams): Promise<Finish> {
    const result = await this.oauth.callback(query);
    const outcome: Finish = result.kind === "refused" ? result :
      result.profile.id !== this.ownerId ? refused(403, "account-not-allowed") :
          { kind: "signed-in", session: this.sessions.create(result.profile.id) };
    if (outcome.kind === "refused") this.log(`login refused: ${outcome.code}`);
    else this.log("login: the owner signed in");
    return outcome;
  }
}
