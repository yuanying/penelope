// Sub-agents (ADR-0022): Pi sessions of their own that the main agent starts
// with its tools and the runner runs in the background. Each run of one goes
// from a request until it answers without calling a tool; then its last text
// goes to the main agent as a `self` event, and it waits for more words or to
// be closed. Their turns are not folded, and they have none of the main
// agent's own tools.
//
// Each sub-agent has a directory of its own under the config's subAgentDir,
// named by its name: agent.json, its record, and the files of its session.
// A name is used once, as the directory stays after the sub-agent is closed.
// The record keeps the notices the backend has not taken yet, so that a
// notice survives the runner stopping and is sent again with the same id.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type AgentSession, parseFrontmatter, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Activity, isSubAgentName, type SubAgentNotice, type SubAgentStopReason, type TurnEndRequest } from "@penelope/contract";

import { TurnRecorder } from "./activities.ts";
import type { Backend } from "./backend.ts";
import type { Config } from "./config.ts";
import type { Connector } from "./connectors.ts";
import { type Assistant, lastAssistant, newSessionFileIn, openSession, type PiSetup } from "./pi.ts";
import { type Places, subAgentSystemPrompt } from "./prompts.ts";

export type SubAgentState = "running" | "waiting" | "closed";

/** A notice to the main agent, as `POST /v1/self-events` takes it. */
export interface PendingNotice {
  id: string;
  summary: string;
  payload: SubAgentNotice;
}

/** What agent.json keeps of a sub-agent. */
export interface SubAgentRecord {
  name: string;
  purpose: string;
  cwd: string;
  role?: string;
  /** Its session file. */
  session: string;
  state: SubAgentState;
  /** How many times it has stopped: the number of its last notice. */
  stops: number;
  /** The turn of the run it is in, while it is running. */
  turn?: string;
  /** Notices the backend has not taken yet, oldest first. */
  pending: PendingNotice[];
}

/** What a tool refuses; its message is the tool's error. */
export class SubAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubAgentError";
  }
}

export interface StartRequest {
  name: string;
  purpose: string;
  prompt: string;
  role?: string;
  cwd?: string;
}

export interface SubAgentsOptions {
  config: Config;
  /** Pi's setup for a sub-agent's session: no tools beside Pi's own, no extensions. */
  setup: PiSetup;
  /** The main agent's client of the backend; each sub-agent calls it as itself. */
  backend: Backend;
  connectors: () => Promise<{ dir: string; list: Connector[] } | undefined>;
  log: (line: string) => void;
  /** The first wait before a notice is sent again; it doubles up to 30 seconds. */
  retryMs: number;
}

interface Live {
  record: SubAgentRecord;
  backend: Backend;
  session?: AgentSession;
  /** The run it is in. */
  run?: Promise<void>;
  closing: boolean;
  delivering: boolean;
  /** Writes of its record, one after another. */
  saving: Promise<void>;
}

/** A role's name is the name of a file in /memory/agents/. */
const ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUMMARY_MAX = 200;
const RETRY_MAX_MS = 30_000;
const RECORD = "agent.json";

/** How a turn went, as the turn's end tells it (docs/sandbox-api.md). */
type Outcome = Pick<TurnEndRequest, "result" | "reason">;

const textOf = (message: Assistant | undefined) =>
  (message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n")
    .trim();

function summaryOf(reason: SubAgentStopReason, text: string): string {
  const line = text.split("\n")[0]!.trim();
  return line ? [...line].slice(0, SUMMARY_MAX).join("") : reason;
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class SubAgents {
  private readonly config: Config;
  private readonly setup: PiSetup;
  private readonly backend: Backend;
  private readonly connectors: SubAgentsOptions["connectors"];
  private readonly log: (line: string) => void;
  private readonly retryMs: number;
  private readonly places: Places;
  /** Every sub-agent there has been, closed ones too. */
  private readonly agents = new Map<string, Live>();
  /** Names being started. */
  private readonly starting = new Set<string>();
  /** Runs and deliveries, which stopping waits for. */
  private readonly tasks = new Set<Promise<void>>();
  private readonly stopped = new AbortController();
  private stopping: Promise<void> | undefined;

  constructor(options: SubAgentsOptions) {
    this.config = options.config;
    this.setup = options.setup;
    this.backend = options.backend;
    this.connectors = options.connectors;
    this.log = options.log;
    this.retryMs = options.retryMs;
    this.places = {
      memory: options.config.memoryDir,
      sources: options.config.sourcesDir,
      home: options.config.home,
      ...(options.config.ownerSkillsDir ? { ownerSkills: options.config.ownerSkillsDir } : {}),
      imageSkills: options.config.imageSkillsDir,
    };
  }

  /**
   * The sub-agents the last runner left. Each that is not closed is told to
   * the backend again; one that was running is waiting now, its cut turn is
   * ended and the main agent is told it was interrupted. Notices not taken
   * yet are sent again.
   */
  async restore(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.config.subAgentDir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      let record: SubAgentRecord;
      try {
        record = JSON.parse(await readFile(join(this.config.subAgentDir, name, RECORD), "utf8")) as SubAgentRecord;
      } catch (error) {
        this.log(`sub-agent ${name} left out: its record cannot be read: ${failure(error)}`);
        continue;
      }
      record.pending ??= [];
      const live = this.live(record);
      this.agents.set(name, live);
      if (record.state !== "closed") {
        const cut = record.state === "running" ? record.turn : undefined;
        if (record.state === "running") {
          this.notice(record, "interrupted", "");
          record.state = "waiting";
          delete record.turn;
          await this.save(live);
        }
        await this.status(live, false);
        if (cut) await this.endTurn(live.backend, cut, { result: "stopped", reason: "The runner stopped during the run." });
      }
      this.deliver(live);
    }
  }

  /** Records written during the main session, including those of agents since closed. */
  async recordsSince(since: number): Promise<string[]> {
    const paths: string[] = [];
    for (const { record } of this.agents.values()) {
      const file = await stat(record.session).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (file?.isFile() && file.mtimeMs >= since) paths.push(record.session);
    }
    return paths.sort();
  }

  /** Starts a sub-agent and returns once its run has begun. */
  async start(request: StartRequest): Promise<string> {
    const { name, purpose } = request;
    if (!isSubAgentName(name)) {
      throw new SubAgentError(
        `${JSON.stringify(name)} cannot be a sub-agent's name: a name is lowercase letters, digits and "-", starts with a letter or a digit, is at most 63 characters long, and is not "main".`,
      );
    }
    if (this.agents.has(name) || this.starting.has(name)) {
      throw new SubAgentError(`There has been a sub-agent named ${name}; a name is used once, closed sub-agents' included.`);
    }
    this.starting.add(name);
    try {
      let cwd: string;
      if (request.cwd !== undefined) {
        cwd = resolve(this.config.home, request.cwd);
        const info = await stat(cwd).catch(() => undefined);
        if (!info) throw new SubAgentError(`The working directory ${cwd} does not exist.`);
        if (!info.isDirectory()) throw new SubAgentError(`The working directory ${cwd} is not a directory.`);
      } else {
        cwd = join(this.config.home, "agents", name);
      }
      const role = await this.role(request.role);
      if (request.cwd === undefined) await mkdir(cwd, { recursive: true });

      const dir = join(this.config.subAgentDir, name);
      await mkdir(this.config.subAgentDir, { recursive: true });
      try {
        await mkdir(dir);
      } catch {
        throw new SubAgentError(`There has been a sub-agent named ${name}; a name is used once, closed sub-agents' included.`);
      }
      const record: SubAgentRecord = {
        name,
        purpose,
        cwd,
        ...(request.role !== undefined ? { role: request.role } : {}),
        session: await newSessionFileIn(cwd, dir),
        state: "waiting",
        stops: 0,
        pending: [],
      };
      const live = this.live(record);
      live.session = await this.open(record, role.file);
      this.agents.set(name, live);
      await this.save(live);
      await this.status(live, false);
      this.begin(live, request.prompt);
      return `Started ${name}, working in ${cwd}.${role.note ? ` ${role.note}` : ""}`;
    } finally {
      this.starting.delete(name);
    }
  }

  /** Sends more words to a waiting sub-agent; returns once its run has begun. */
  async send(name: string, text: string): Promise<string> {
    const live = this.find(name);
    const busy = () => new SubAgentError(`${name} is running; words go only to a sub-agent that has stopped and is waiting.`);
    if (live.record.state !== "waiting") throw busy();
    if (!live.session) {
      const role = await this.role(live.record.role);
      if (!live.session) live.session = await this.open(live.record, role.file);
    }
    if (live.record.state !== "waiting" || live.closing) throw busy();
    this.begin(live, text);
    return `Sent to ${name}; it is running.`;
  }

  /** The sub-agents that are not closed. */
  list(): { name: string; state: SubAgentState; purpose: string; cwd: string }[] {
    return [...this.agents.values()]
      .filter((live) => live.record.state !== "closed")
      .map(({ record }) => ({ name: record.name, state: record.state, purpose: record.purpose, cwd: record.cwd }));
  }

  /** Closes a sub-agent, cancelling the run it is in. */
  async close(name: string): Promise<string> {
    const live = this.find(name);
    if (live.closing) throw new SubAgentError(`${name} is being closed.`);
    live.closing = true;
    if (live.run) {
      await live.session?.abort();
      await live.run;
    }
    live.record.state = "closed";
    delete live.record.turn;
    await this.save(live);
    live.session?.dispose();
    delete live.session;
    await this.status(live, true);
    return `Closed ${name}.`;
  }

  /**
   * Cancels the runs and the deliveries as the runner stops. A cancelled run
   * stays running in its record, for the next runner to tell.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped.abort();
      for (const live of this.agents.values()) if (live.run) await live.session?.abort();
      while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
      for (const live of this.agents.values()) {
        await live.saving.catch((error: unknown) => this.log(`record of ${live.record.name} not written: ${failure(error)}`));
        live.session?.dispose();
      }
    })();
    return this.stopping;
  }

  // ── Within ──

  private live(record: SubAgentRecord): Live {
    return { record, backend: this.backend.as(record.name), closing: false, delivering: false, saving: Promise.resolve() };
  }

  private find(name: string): Live {
    const live = this.agents.get(name);
    if (!live) throw new SubAgentError(`There is no sub-agent named ${name}.`);
    if (live.record.state === "closed") throw new SubAgentError(`${name} is closed.`);
    return live;
  }

  /**
   * The body of the role's file, or of default.md without a role. A role
   * that cannot be read refuses the start; default.md that cannot be read
   * leaves the fixed part alone, with a note.
   */
  private async role(role: string | undefined): Promise<{ file?: { path: string; body: string }; note?: string }> {
    if (role !== undefined && (!ROLE.test(role) || role.includes(".."))) {
      throw new SubAgentError(`${JSON.stringify(role)} is not the name of a role: a role is a file ${join(this.config.memoryDir, "agents")}/<role>.md.`);
    }
    const path = join(this.config.memoryDir, "agents", `${role ?? "default"}.md`);
    let problem: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        problem = `${path} is not a file`;
      } else if (info.size > this.config.promptFileMaxBytes) {
        problem = `${path} is ${info.size} bytes, over the ${this.config.promptFileMaxBytes} bytes a system prompt takes from one file`;
      } else {
        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8"));
        const named = (key: string) => typeof frontmatter[key] === "string" && (frontmatter[key] as string).trim() !== "";
        if (named("name") && named("description")) return { file: { path, body } };
        problem = `${path} has no name and description in its front matter`;
      }
    } catch (error) {
      problem = (error as NodeJS.ErrnoException).code === "ENOENT" ? `${path} does not exist` : `${path} cannot be read: ${failure(error)}`;
    }
    if (role !== undefined) throw new SubAgentError(`The role ${role} cannot be used: ${problem}.`);
    return { note: `${problem[0]!.toUpperCase()}${problem.slice(1)}, so its system prompt has the fixed part alone.` };
  }

  private async open(record: SubAgentRecord, role: { path: string; body: string } | undefined): Promise<AgentSession> {
    const connectors = await this.connectors();
    const prompt = subAgentSystemPrompt(
      this.config.identity,
      this.places,
      { name: record.name, purpose: record.purpose, cwd: record.cwd, ...(role ? { role } : {}) },
      connectors ? { connectors } : {},
    );
    const dir = join(this.config.subAgentDir, record.name);
    const { session } = await openSession(this.setup, prompt, SessionManager.open(record.session, dir, record.cwd), record.cwd);
    return session;
  }

  private begin(live: Live, input: string): void {
    const run = this.run(live, input).catch((error: unknown) => this.log(`sub-agent ${live.record.name}: ${failure(error)}`));
    live.run = run;
    this.track(run.finally(() => {
      if (live.run === run) delete live.run;
    }));
  }

  /** One run: from `input` until it stops. Its state is running from the call on. */
  private async run(live: Live, input: string): Promise<void> {
    const { record } = live;
    const turnId = randomUUID();
    record.state = "running";
    record.turn = turnId;
    await this.save(live);
    let sending = Promise.resolve();
    const send = (activity: Activity) => {
      sending = sending
        .then(() => live.backend.activity([activity]))
        .catch((error: unknown) => this.log(`activity of ${record.name} not sent: ${failure(error)}`));
    };
    const session = live.session!;
    const recorder = new TurnRecorder(turnId, () => new Date().toISOString(), send);
    const unsubscribe = session.subscribe((event) => recorder.handle(event));
    recorder.start();
    let reason: SubAgentStopReason = "stopped";
    let text = "";
    let cancelled = false;
    try {
      await this.setup.turnModels.prepare(session, this.stopped.signal);
      if (this.stopped.signal.aborted || live.closing) {
        cancelled = true;
      } else {
        await session.prompt(input);
        const last = lastAssistant(session.messages);
        if (last?.stopReason === "aborted") cancelled = true;
        else if (last?.stopReason === "error") [reason, text] = ["failed", last.errorMessage ?? "The model's request failed."];
        else text = textOf(last);
      }
    } catch (error) {
      [reason, text] = ["failed", failure(error)];
    } finally {
      unsubscribe();
    }
    // Cut by the runner stopping: the next runner ends the turn and tells the main agent.
    if (this.stopped.signal.aborted && (cancelled || reason === "failed")) return;
    let outcome: Outcome = { result: "done" };
    if (live.closing && cancelled) {
      outcome = { result: "stopped", reason: "Closed by subagent_close." };
    } else {
      if (cancelled) [reason, text] = ["failed", "The run was cancelled."];
      if (reason === "failed") outcome = { result: "failed", reason: text };
    }
    if (!live.closing) {
      this.notice(record, reason, text);
      record.state = "waiting";
      delete record.turn;
      await this.save(live);
    }
    recorder.end();
    await sending;
    await this.endTurn(live.backend, turnId, outcome, false);
    if (!live.closing) this.deliver(live);
  }

  private notice(record: SubAgentRecord, reason: SubAgentStopReason, text: string): void {
    record.stops++;
    record.pending.push({
      id: `${record.name}/${record.stops}`,
      summary: summaryOf(reason, text),
      payload: { reason, purpose: record.purpose, text },
    });
  }

  /** Sends the notices not taken yet, in order, each again until the backend takes it. */
  private deliver(live: Live): void {
    if (live.delivering || live.record.pending.length === 0) return;
    live.delivering = true;
    this.track(
      (async () => {
        let failures = 0;
        try {
          while (live.record.pending.length > 0 && !this.stopped.signal.aborted) {
            const notice = live.record.pending[0]!;
            try {
              await live.backend.selfEvent(notice);
            } catch (error) {
              failures++;
              this.log(`notice ${notice.id} not sent: ${failure(error)}`);
              await this.sleep(Math.min(this.retryMs * 2 ** (failures - 1), RETRY_MAX_MS));
              continue;
            }
            failures = 0;
            live.record.pending.shift();
            await this.save(live);
          }
        } finally {
          live.delivering = false;
        }
      })(),
    );
  }

  /** The end of a turn: the activity for the UI, then the call that commits /memory. */
  private async endTurn(backend: Backend, turnId: string, outcome: Outcome, activity = true): Promise<void> {
    if (activity) {
      await backend
        .activity([{ kind: "turn_end", at: new Date().toISOString(), turn_id: turnId }])
        .catch((error: unknown) => this.log(`activity of ${backend.agent} not sent: ${failure(error)}`));
    }
    await backend.turnEnd({ turn_id: turnId, ...outcome }).catch((error: unknown) => this.log(`turn end of ${backend.agent} not sent: ${failure(error)}`));
  }

  private async status(live: Live, closed: boolean): Promise<void> {
    try {
      await live.backend.subAgentStatus({ purpose: live.record.purpose, closed });
    } catch (error) {
      this.log(`status of ${live.record.name} not sent: ${failure(error)}`);
    }
  }

  private save(live: Live): Promise<void> {
    const path = join(this.config.subAgentDir, live.record.name, RECORD);
    const text = `${JSON.stringify(live.record)}\n`;
    const next = live.saving
      .catch(() => undefined)
      .then(async () => {
        await writeFile(`${path}.tmp`, text, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      });
    live.saving = next;
    return next;
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.stopped.signal;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
