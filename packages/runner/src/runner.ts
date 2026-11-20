// The runner: it takes events from the backend and makes turns of them in her
// one session (ADR-0002), reports what happens in each turn, and switches the
// session at night (ADR-0007).
//
// One turn is one run of Pi: from the prompt until Pi will not go on by
// itself. An event that comes during a turn joins it: `now` as a steer,
// with the batched events handed over beside it, and `batch` alone as a
// follow-up. The events of a turn are acked after the backend
// has been told the turn ended. An event that comes again, as the backend
// hands over one that is not acked yet, is dropped by its seq.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  Activity,
  ControlPayload,
  DeliveredEvent,
  NightStage,
  NightStages,
  NightTurnStage,
  TurnEndRequest,
} from "@penelope/contract";

import { TurnRecorder } from "./activities.ts";
import type { Backend } from "./backend.ts";
import type { Config } from "./config.ts";
import { type Connector, readConnectors } from "./connectors.ts";
import { MemoryExtensionTrials } from "./extensions.ts";
import { FOLD_ASK, foldExtension, TURN_END } from "./fold.ts";
import { inlineImages } from "./images.ts";
import { Jobs } from "./jobs.ts";
import { TurnModels } from "./model-settings.ts";
import { memoryChanges, memorySnapshot } from "./night-memory.ts";
import { nightTools } from "./night-tools.ts";
import {
  nightManager,
  lastAssistant,
  newSessionFile,
  openFile,
  openSession,
  type OpenSession,
  type PiSetup,
  readState,
  type SessionState,
  writeState,
} from "./pi.ts";
import {
  curatorInput,
  curatorSystemPrompt,
  foldAskInput,
  type Places,
  PROMPT_FILES,
  readPromptFiles,
  reflectionInput,
  systemPrompt,
  VERIFIER,
  verifierInput,
  verifierSystemPrompt,
} from "./prompts.ts";
import { SubAgents } from "./subagents.ts";
import { backendTools, jobTools, subAgentTools } from "./tools.ts";
import { formatEvents, withExtensionNotes } from "./turn-input.ts";

export interface RunnerOptions {
  config: Config;
  backend: Backend;
  modelRuntime: ModelRuntime;
  settings: () => SettingsManager;
  log?: (line: string) => void;
  /** The first wait before a sub-agent's notice or a job's end is sent again (ADR-0022, ADR-0030). */
  retryMs?: number;
}

/** How a turn went, as its end tells the backend (docs/sandbox-api.md, "ターンの結果ときっかけ"). */
type Outcome = Required<Pick<TurnEndRequest, "result">> & Pick<TurnEndRequest, "reason">;

interface TurnOptions {
  /** The seqs of the events handed in as its input; events join an ordinary turn only. */
  seqs?: number[];
  /** For a turn of the nightly switch: its control event and step. The turn is not ordinary. */
  night?: { seq: number; stage: NightTurnStage };
  images?: ImageContent[];
  heartbeat?: boolean;
}

interface Turn {
  session: AgentSession;
  seqs: number[];
  /** Whether every event of the turn so far is a heartbeat (ADR-0031). */
  heartbeat: boolean;
  /** The steers and follow-ups handed to Pi during the turn, until Pi has them. */
  queued: Promise<unknown>[];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const isHeartbeat = (event: DeliveredEvent) => event.source === "heartbeat";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A turn of the night as its step: a turn the runner cut is a step that did not get done. */
const stageOf = ({ result, reason }: Outcome): NightStage =>
  result === "done" ? { result } : { result: "failed", reason: result === "stopped" ? `Stopped: ${reason}` : (reason ?? "") };

export class Runner {
  private readonly config: Config;
  private readonly backend: Backend;
  private readonly setup: PiSetup;
  private readonly log: (line: string) => void;
  private readonly places: Places;
  private readonly subAgents: SubAgents;
  private readonly jobs: Jobs;
  private readonly extensionTrials: MemoryExtensionTrials;

  private session: OpenSession | undefined;
  private state: SessionState | undefined;
  private turn: Turn | undefined;
  /** The id of the turn under way, for a reply to carry. */
  private turnId: string | undefined;
  /** Events being handled or handled: a second delivery of one is dropped. */
  private readonly taken = new Set<number>();
  private readonly inbox: DeliveredEvent[] = [];
  private wake: (() => void) | undefined;
  private sending: Promise<void> = Promise.resolve();
  /** While the request before folding is answered, no tool runs. */
  private asking = false;
  /** How many ended turns the last model call had folded. */
  private folded = 0;
  private stopping = false;

  constructor(options: RunnerOptions) {
    this.config = options.config;
    this.backend = options.backend;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.extensionTrials = new MemoryExtensionTrials(join(this.config.home, ".penelope-extension-trials.json"), this.log);
    const turnModels = new TurnModels(options.modelRuntime, this.backend, this.log);
    const pi = { config: options.config, modelRuntime: options.modelRuntime, turnModels, settings: options.settings, log: this.log };
    // A sub-agent has Pi's tools alone, and its turns are not folded.
    this.subAgents = new SubAgents({
      config: options.config,
      setup: { ...pi, tools: [], extensions: [] },
      backend: options.backend,
      connectors: () => this.connectors(),
      log: this.log,
      retryMs: options.retryMs ?? 1000,
    });
    // Only the main agent has jobs: their ends reach only it (ADR-0030).
    this.jobs = new Jobs({
      home: options.config.home,
      dir: options.config.jobDir,
      limits: options.config.jobs,
      backend: options.backend,
      log: this.log,
      retryMs: options.retryMs ?? 1000,
    });
    this.setup = {
      ...pi,
      tools: [...backendTools(options.backend, { home: options.config.home, turn: () => this.turnId }), ...subAgentTools(this.subAgents), ...jobTools(this.jobs, options.config.jobs)],
      extensions: [
        foldExtension({
          folding: () => options.config.turnFold,
          asking: () => this.asking,
          folded: (count) => (this.folded = count),
        }),
      ],
    };
    this.places = {
      memory: options.config.memoryDir,
      sources: options.config.sourcesDir,
      home: options.config.home,
      ...(options.config.ownerSkillsDir ? { ownerSkills: options.config.ownerSkillsDir } : {}),
      imageSkills: options.config.imageSkillsDir,
    };
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    await this.extensionTrials.restore();
    await this.open();
    await this.subAgents.restore();
    await this.jobs.restore();
    signal.addEventListener("abort", () => {
      this.stopping = true;
      this.wake?.();
      void this.session?.session.abort();
      void this.subAgents.stop();
      void this.jobs.stop();
    });
    try {
      await Promise.all([this.poll(signal), this.work(signal)]);
    } finally {
      await this.subAgents.stop();
      await this.jobs.stop();
      this.session?.session.dispose();
    }
  }

  /** The connectors' documents as they are now; none without a directory. */
  private async connectors(): Promise<{ dir: string; list: Connector[] } | undefined> {
    const dir = this.config.connectorsDir;
    if (!dir) return undefined;
    const { connectors: list, skipped } = await readConnectors(dir);
    for (const { path, reason } of skipped) this.log(`connector left out: ${path} ${reason}`);
    return { dir, list };
  }

  private async mainPrompt(): Promise<string> {
    const files = await readPromptFiles(this.config.memoryDir, this.config.promptFileMaxBytes);
    const connectors = await this.connectors();
    return systemPrompt(this.config.identity, this.places, files, {
      folding: this.config.turnFold,
      slackSources: this.config.slack.sources,
      ...(connectors ? { connectors } : {}),
    });
  }

  private async openMainSession(file: string): Promise<OpenSession> {
    return openSession(
      { ...this.setup, diskExtensions: { trials: this.extensionTrials, log: this.log } },
      await this.mainPrompt(),
      openFile(this.config, file),
    );
  }

  /** Her session as the last run left it, or a new one. */
  private async open(): Promise<void> {
    this.state = await readState(this.config);
    if (!this.state) {
      this.state = { file: await newSessionFile(this.config) };
      await writeState(this.config, this.state);
    }
    this.session = await this.openMainSession(this.state.file);
  }

  // ── Taking events ──

  private async poll(signal: AbortSignal): Promise<void> {
    let after = 0;
    let failures = 0;
    while (!signal.aborted) {
      let events: DeliveredEvent[];
      try {
        await this.setup.turnModels.report(signal);
        if (signal.aborted) return;
        events = await this.backend.poll(after, this.config.pollWaitSeconds, signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        failures++;
        this.log(`poll failed: ${(error as Error).message}`);
        await sleep(Math.min(1000 * 2 ** (failures - 1), 30_000), signal);
        continue;
      }
      const fresh = events.filter((event) => !this.taken.has(event.seq));
      for (const event of fresh) {
        this.taken.add(event.seq);
        after = Math.max(after, event.seq);
      }
      if (fresh.length > 0) this.deliver(fresh);
    }
  }

  /** Into the running turn when there is one, else into the inbox for the next. */
  private deliver(events: DeliveredEvent[]): void {
    const turn = this.turn;
    const control = events.some((event) => event.source === "control");
    if (!turn || control || this.inbox.length > 0) {
      this.inbox.push(...events);
      this.wake?.();
      return;
    }
    // A `now` brings the batched events handed over with it into the same
    // steer, so that the turn sees it with what led up to it. Batched events
    // alone follow the turn.
    turn.seqs.push(...events.map((event) => event.seq));
    turn.heartbeat &&= events.every(isHeartbeat);
    const steer = events.some((event) => event.delivery === "now");
    turn.queued.push(
      this.input(events).then(([text, images]) =>
        steer ? turn.session.steer(text, images) : turn.session.followUp(text, images),
      ),
    );
  }

  /** The text of the events, and the images of the owner's messages among them. */
  private async input(events: DeliveredEvent[]): Promise<[string, ImageContent[] | undefined]> {
    const images = await inlineImages(events, this.config.imageMaxBytes);
    const slack = this.config.slack;
    const drawing = slack.sources.length > 0 ? { sources: new Set(slack.sources), sourcesDir: this.config.sourcesDir, maxChars: slack.maxChars, log: this.log } : undefined;
    return [formatEvents(events, drawing), images.length > 0 ? images : undefined];
  }

  // ── Making turns ──

  private async work(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.inbox.length === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = undefined;
        continue;
      }
      const first = this.inbox[0]!;
      if (first.source === "control") {
        this.inbox.shift();
        await this.control(first);
        continue;
      }
      const until = this.inbox.findIndex((event) => event.source === "control");
      const events = this.inbox.splice(0, until < 0 ? this.inbox.length : until);
      const [text, images] = await this.input(events);
      await this.turnOf(this.session!.session, text, {
        seqs: events.map((event) => event.seq),
        ...(images ? { images } : {}),
        heartbeat: events.every(isHeartbeat),
      });
    }
  }

  private send(activity: Activity): void {
    this.sending = this.sending
      .then(() => this.backend.activity([activity]))
      .catch((error: unknown) => this.log(`activity not sent: ${(error as Error).message}`));
  }

  /**
   * One turn: Pi runs `input`, and what comes during it joins it. Then the
   * backend is told the turn ended (it commits /memory), and the events are
   * acked. A turn that fails is not acked: the backend hands its events over
   * again. The end tells how the turn went and what was handed into it, for
   * the activity record (ADR-0038); that is also what this returns.
   *
   * An ordinary turn is one of her day's session, made of events: events can
   * join it, and when it ends it is marked so that it is folded from then on
   * (ADR-0015). One that ended without any text of hers is first asked, once,
   * for what she wants to keep, unless it was a heartbeat's alone and called
   * no tool, so that nothing happened in it (ADR-0031). The nightly turns are not ordinary.
   */
  private async turnOf(session: AgentSession, input: string, options: TurnOptions = {}): Promise<Outcome> {
    const { night, images } = options;
    const ordinary = night === undefined;
    const main = this.session?.session === session ? this.session : undefined;
    let preparing: string | undefined;
    try {
      if (main) input = withExtensionNotes(input, await main.beforeTurn());
    } catch (error) {
      preparing = `Could not reload extensions: ${failure(error)}`;
    }
    const recorder = new TurnRecorder(randomUUID(), () => new Date().toISOString(), (activity) => this.send(activity));
    let spoke = false;
    let called = false;
    let compactions = 0;
    const unsubscribe = session.subscribe((event) => {
      recorder.handle(event);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
        spoke ||= event.assistantMessageEvent.content.trim() !== "";
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
        called = true;
      } else if (event.type === "compaction_end" && event.result && !event.aborted) {
        compactions++;
      }
    });
    const turn: Turn = { session, seqs: [...(options.seqs ?? [])], heartbeat: options.heartbeat ?? false, queued: [] };
    this.turnId = recorder.turnId;
    this.folded = 0;
    recorder.start();
    let failed = false;
    let thrown: string | undefined;
    let asked = false;
    try {
      if (preparing !== undefined) throw new Error(preparing);
      if (this.stopping) throw new Error("The runner was stopping.");
      await this.setup.turnModels.prepare(session);
      if (this.stopping) throw new Error("The runner was stopping.");
      if (ordinary) this.turn = turn;
      let text = input;
      let withImages = images;
      for (;;) {
        await session.prompt(text, withImages ? { images: withImages } : undefined);
        withImages = undefined;
        // Pi may have finished before a steer or follow-up reached it; what is
        // left in its queue is run as a prompt of the same turn.
        let count = 0;
        while (count !== turn.queued.length) {
          count = turn.queued.length;
          await Promise.allSettled(turn.queued);
        }
        if (session.pendingMessageCount === 0) break;
        const { steering, followUp } = session.clearQueue();
        text = [...steering, ...followUp].join("\n\n");
      }
    } catch (error) {
      failed = true;
      thrown = failure(error);
      this.log(`turn ${recorder.turnId} failed: ${thrown}`);
    } finally {
      if (ordinary) this.turn = undefined;
    }
    let outcome = this.outcome(session, thrown);
    if (ordinary && !failed) {
      const idle = turn.heartbeat && !called;
      if (this.config.turnFold && !spoke && !idle && !this.stopping) {
        asked = true;
        const asking = this.outcome(session, await this.ask(session, recorder.turnId));
        if (outcome.result === "done" && asking.result !== "done") {
          outcome = { ...asking, reason: `The request before folding: ${asking.reason ?? ""}` };
        }
      }
      await session.sendCustomMessage({ customType: TURN_END, content: "", display: false });
    }
    unsubscribe();
    await main?.finishTurn(outcome.result);
    this.log(`turn ${recorder.turnId}: folded ${this.folded}, asked ${asked ? "yes" : "no"}, compactions ${compactions}`);
    recorder.end();
    await this.sending;
    this.turnId = undefined;
    try {
      await this.backend.turnEnd({
        turn_id: recorder.turnId,
        ...outcome,
        ...(ordinary ? { seqs: turn.seqs } : { night }),
      });
    } catch (error) {
      this.log(`turn end not sent: ${failure(error)}`);
    }
    if (failed) {
      for (const seq of turn.seqs) this.taken.delete(seq);
      return outcome;
    }
    await this.ack(turn.seqs);
    return outcome;
  }

  /**
   * How the run of a turn went, from what it threw and the model's last
   * answer. One the runner cut as it stops is stopped; one that is unclear
   * is failed, so that the owner sees it.
   */
  private outcome(session: AgentSession, thrown: string | undefined): Outcome {
    const last = lastAssistant(session.messages);
    if (this.stopping && (thrown !== undefined || last?.stopReason === "aborted")) {
      return { result: "stopped", reason: "The runner was stopping." };
    }
    if (thrown !== undefined) return { result: "failed", reason: thrown };
    if (last?.stopReason === "error") return { result: "failed", reason: last.errorMessage ?? "The model's request failed." };
    if (last?.stopReason === "aborted") return { result: "failed", reason: "The run was cancelled." };
    return { result: "done" };
  }

  /** The request before folding; what it threw, if it did. Events that come meanwhile wait for the next turn. */
  private async ask(session: AgentSession, turnId: string): Promise<string | undefined> {
    this.asking = true;
    try {
      await session.sendCustomMessage({ customType: FOLD_ASK, content: foldAskInput(), display: false }, { triggerTurn: true });
      return undefined;
    } catch (error) {
      this.log(`turn ${turnId}: the request before folding failed: ${failure(error)}`);
      return failure(error);
    } finally {
      this.asking = false;
    }
  }

  private async ack(seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    try {
      await this.backend.ack(seqs);
    } catch (error) {
      this.log(`ack not sent: ${(error as Error).message}`);
    }
  }

  // ── The nightly switch ──

  private async control(event: DeliveredEvent): Promise<void> {
    const payload = (event.inline ? event.payload : undefined) as ControlPayload | undefined;
    if (payload?.kind !== "nightly") {
      this.log(`unknown control event ${event.seq}; acked without action`);
      await this.ack([event.seq]);
      return;
    }
    // A nightly event that comes again after its switch was made only needs telling.
    const made = this.state?.nightly === event.seq;
    const stages = made ? undefined : await this.nightly(event.seq);
    await this.backend
      .rotated({ seq: event.seq, ...(stages ? { stages } : {}) })
      .catch((error: unknown) => this.log(`rotation not sent: ${failure(error)}`));
    // Without a new session the event is not acked: it comes again, and the night is run again.
    if (stages && stages.session.result !== "done") {
      this.taken.delete(event.seq);
      return;
    }
    await this.ack([event.seq]);
  }

  /** Each step is attempted even if one before it failed (ADR-0044). */
  private async nightly(seq: number): Promise<NightStages> {
    const nightStarted = new Date().toISOString();
    const { memoryDir, identity } = this.config;
    const before = this.state?.nightMemory;
    const reflection = await this.nightStage("reflection", async () => {
      const sizes: Partial<Record<string, number>> = {};
      for (const name of PROMPT_FILES) {
        const info = await stat(join(memoryDir, name)).catch(() => undefined);
        if (info?.isFile()) sizes[name] = info.size;
      }
      return stageOf(await this.turnOf(this.session!.session, reflectionInput(this.places, sizes), { night: { seq, stage: "reflection" } }));
    });
    const verifier = await this.nightStage(VERIFIER, async () => {
      const main = this.state!.file;
      const header = this.session!.session.sessionManager.getHeader();
      if (!header) throw new Error("The daytime session has no header.");
      const records = await this.subAgents.recordsSince(Date.parse(header.timestamp));
      const memory = await memorySnapshot(memoryDir);
      return this.nightWorker(seq, VERIFIER, verifierSystemPrompt(identity, this.places),
        verifierInput(this.places, { started: header.timestamp, ended: nightStarted, main, subAgents: records },
          memoryChanges(before, memory), before !== undefined),
        nightTools(this.config, [main, ...records]));
    });
    const curator = await this.nightStage("curator", async () => {
      const memory = await memorySnapshot(memoryDir);
      return this.nightWorker(seq, "curator", curatorSystemPrompt(identity, this.places),
        curatorInput(memory, memoryChanges(before, memory), before !== undefined),
        nightTools(this.config));
    });
    let session: NightStage;
    try {
      const nightMemory = await memorySnapshot(memoryDir).catch((error: unknown) => {
        this.log(`night memory baseline not kept: ${failure(error)}`);
        return undefined;
      });
      const state: SessionState = { file: await newSessionFile(this.config), nightly: seq, ...(nightMemory ? { nightMemory } : {}) };
      const next = await this.openMainSession(state.file);
      try {
        await writeState(this.config, state);
      } catch (error) {
        next.session.dispose();
        throw error;
      }
      this.session?.session.dispose();
      this.session = next;
      this.state = state;
      session = { result: "done" };
    } catch (error) {
      this.log(`the new session could not start: ${failure(error)}`);
      session = { result: "failed", reason: `The new session could not start: ${failure(error)}` };
    }
    return { reflection, verifier, curator, session };
  }

  private async nightStage(stage: NightTurnStage, run: () => Promise<NightStage>): Promise<NightStage> {
    try {
      return await run();
    } catch (error) {
      const reason = `The ${stage} could not run: ${failure(error)}`;
      this.log(reason);
      return { result: "failed", reason };
    }
  }

  private async nightWorker(
    seq: number, stage: Exclude<NightTurnStage, "reflection">, system: string, input: string, tools: PiSetup["tools"],
  ): Promise<NightStage> {
    const { session } = await openSession(
      { ...this.setup, tools, extensions: [], fileOnly: true }, system,
      nightManager(this.config, stage), this.config.memoryDir,
    );
    try {
      return stageOf(await this.turnOf(session, input, { night: { seq, stage } }));
    } finally {
      session.dispose();
    }
  }
}
