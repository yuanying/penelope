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
import { join } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import { type AgentSession, calculateContextTokens, type ModelRuntime, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  Activity,
  ContextUsage,
  ControlPayload,
  DeliveredEvent,
  MemoryReadsSnapshot,
  NightStage,
  NightStages,
  NightTurnReport,
  NightTurnStage,
  TurnEndRequest,
} from "@penelope/contract";

import { TurnRecorder } from "./activities.ts";
import { ANSWER_REMINDER, AnswerReminder } from "./answer-reminder.ts";
import { type Backend, BackendError } from "./backend.ts";
import type { Config } from "./config.ts";
import { type Connector, readConnectors } from "./connectors.ts";
import { MemoryExtensionTrials } from "./extensions.ts";
import { FOLD_ASK, foldExtension, TURN_END } from "./fold.ts";
import { withHeartbeatPending } from "./heartbeat-pending.ts";
import { inlineImages } from "./images.ts";
import { Jobs } from "./jobs.ts";
import { memoryMap } from "./memory-map.ts";
import { shareMemory } from "./memory-permissions.ts";
import { memoryReads, NIGHT_REFLECTION } from "./memory-reads.ts";
import { planArchive, reviewTopics, weekDiary } from "./memory-review.ts";
import { TurnModels } from "./model-settings.ts";
import { MemoryMoves, repairMemoryReferences } from "./memory-moves.ts";
import { type DaytimeRecords, memoryChanges, memorySnapshot } from "./night-memory.ts";
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
  alwaysReadLayer,
  curatorInput,
  curatorSystemPrompt,
  foldAskInput,
  type Places,
  readPromptFiles,
  reflectionInput,
  reviewContentInput,
  reviewStructureInput,
  systemPrompt,
  VERIFIER,
  verifierInput,
  verifierSystemPrompt,
} from "./prompts.ts";
import { SubAgents } from "./subagents.ts";
import type { HouseConnection } from "./house.ts";
import { backendTools, jobTools, subAgentTools } from "./tools.ts";
import { formatEvents, withRunnerNotes } from "./turn-input.ts";

export interface RunnerOptions {
  config: Config;
  backend: Backend;
  house?: HouseConnection;
  modelRuntime: ModelRuntime;
  settings: () => SettingsManager;
  imageLimits?: ReadonlyMap<string, number>;
  log?: (line: string) => void;
  /** The first wait before a sub-agent's notice or a job's end is sent again (ADR-0022, ADR-0030). */
  retryMs?: number;
}

/** How a turn went, as its end tells the backend (docs/sandbox-api.md, "ターンの結果ときっかけ"). */
type Outcome = Required<Pick<TurnEndRequest, "result">> & Pick<TurnEndRequest, "reason">;

interface TurnOptions {
  /** The initial events; events join an ordinary turn only. */
  events?: DeliveredEvent[];
  /** For a turn of the nightly switch: its control event and step. The turn is not ordinary. */
  night?: { seq: number; stage: NightTurnStage };
  afterCommit?: (turnId: string) => Promise<void>;
  images?: ImageContent[];
}

interface Turn {
  session: AgentSession;
  seqs: number[];
  /** The steers and follow-ups handed to Pi during the turn, until Pi has them. */
  queued: Promise<unknown>[];
  answers: AnswerReminder | undefined;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

const modelError = (message: { errorMessage?: string }) => message.errorMessage ?? "The provider did not give a reason.";

/** A turn of the night as its step: a turn the runner cut is a step that did not get done. */
const stageOf = ({ result, reason, turn_id }: Outcome & { turn_id: string }): NightTurnReport =>
  result === "done" ? { result, turn_id } : { result: "failed", reason: result === "stopped" ? `Stopped: ${reason}` : (reason ?? ""), turn_id };

const utcDay = (time: string): number => Math.floor(Date.parse(time) / 86_400_000);

export class Runner {
  private readonly config: Config;
  private readonly backend: Backend;
  private readonly house: HouseConnection | undefined;
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
    this.house = options.house;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.backend.beforeTurnEnd(() => shareMemory(this.config.memoryDir, this.log));
    this.extensionTrials = new MemoryExtensionTrials(join(this.config.home, ".penelope-extension-trials.json"), this.log);
    const turnModels = new TurnModels(options.modelRuntime, this.backend, this.log);
    const pi = { config: options.config, modelRuntime: options.modelRuntime, turnModels, settings: options.settings, log: this.log, imageLimits: options.imageLimits };
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
      tools: [
        ...backendTools(this.backend, {
          home: this.config.home,
          ...(this.house ? { house: this.house } : {}),
          recordHouseReply: (speech_id) => {
            if (this.turnId) this.send({ kind: "house_reply", turn_id: this.turnId, at: new Date().toISOString(), speech_id });
          },
        }),
        ...subAgentTools(this.subAgents), ...jobTools(this.jobs, options.config.jobs),
      ],
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
      house: this.house !== undefined,
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
    const steer = events.some((event) => event.delivery === "now");
    turn.queued.push(
      this.input(events).then(([text, images]) => {
        turn.answers?.input(text, events);
        return steer ? turn.session.steer(text, images) : turn.session.followUp(text, images);
      }),
    );
  }

  /** The text of the events, and the images of the owner's messages among them. */
  private async input(events: DeliveredEvent[]): Promise<[string, ImageContent[] | undefined]> {
    const images = await inlineImages(events, this.config.imageMaxBytes);
    const slack = this.config.slack;
    const drawing = slack.sources.length > 0 ? { sources: new Set(slack.sources), sourcesDir: this.config.sourcesDir, maxChars: slack.maxChars, log: this.log } : undefined;
    const enriched = withHeartbeatPending(events, this.jobs, this.subAgents, this.log);
    return [formatEvents(enriched, drawing), images.length > 0 ? images : undefined];
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
        events,
        ...(images ? { images } : {}),
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
   * acked unless running Pi threw. A provider error returned by Pi is still a
   * finished attempt. The end tells how the turn went and what was handed into it, for
   * the activity record (ADR-0038); that is also what this returns.
   *
   * An ordinary turn is one of her day's session, made of events: events can
   * join it, and when it ends it is marked so that it is folded from then on
   * (ADR-0015). The request before folding is for turns that called a tool
   * but wrote no text (ADR-0071). The nightly turns are not ordinary.
   */
  private async turnOf(session: AgentSession, input: string, options: TurnOptions = {}): Promise<Outcome & { turn_id: string }> {
    const { night, images } = options;
    const ordinary = night === undefined;
    const main = this.session?.session === session ? this.session : undefined;
    const previous = lastAssistant(session.messages);
    const previousModelError = previous?.stopReason === "error" ? modelError(previous) : undefined;
    const answers = ordinary && main && options.events ? new AnswerReminder() : undefined;
    if (options.events) answers?.input(input, options.events);
    let preparing: string | undefined;
    try {
      const notices = await main?.beforeTurn() ?? [];
      const status = ordinary && main
        ? await this.backend.status(AbortSignal.timeout(5_000)).catch((error: unknown) => {
          if (!(error instanceof BackendError && error.status === 404)) this.log(`status not read: ${failure(error)}`);
          return undefined;
        })
        : undefined;
      input = withRunnerNotes(input, notices, previousModelError, status);
    } catch (error) {
      preparing = `Could not reload extensions: ${failure(error)}`;
    }
    const recorder = new TurnRecorder(randomUUID(), () => new Date().toISOString(), (activity) => this.send(activity));
    let spoke = false;
    let called = false;
    let compactions = 0;
    let context: ContextUsage | undefined;
    const unsubscribe = session.subscribe((event) => {
      recorder.handle(event);
      answers?.observe(event);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
        spoke ||= event.assistantMessageEvent.content.trim() !== "";
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
        called = true;
      } else if (event.type === "compaction_end" && event.result && !event.aborted) {
        compactions++;
        context = undefined;
      } else if (ordinary && main && event.type === "message_end" && event.message.role === "assistant") {
        const { stopReason, usage } = event.message;
        const tokens = calculateContextTokens(usage);
        const context_window = session.model?.contextWindow;
        if (stopReason !== "aborted" && stopReason !== "error"
          && Number.isSafeInteger(tokens) && tokens > 0
          && context_window !== undefined && Number.isSafeInteger(context_window) && context_window > 0) {
          context = { tokens, context_window };
        }
      }
    });
    const turn: Turn = { session, seqs: options.events?.map((event) => event.seq) ?? [], queued: [], answers };
    this.turnId = recorder.turnId;
    this.folded = 0;
    recorder.start();
    let failed = false;
    let thrown: string | undefined;
    let asked = false;
    let remindedAt: number | undefined;
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
      // Like the fold request, this is part of the turn but takes no new events.
      if (ordinary) this.turn = undefined;
      if (answers && !this.stopping && this.outcome(session, undefined).result === "done") {
        const notice = answers.notice();
        if (notice !== undefined) {
          remindedAt = answers.toolCalls;
          await session.sendCustomMessage({ customType: ANSWER_REMINDER, content: notice, display: false }, { triggerTurn: true });
        }
      }
    } catch (error) {
      failed = true;
      thrown = failure(error);
      this.log(`turn ${recorder.turnId} failed: ${thrown}`);
    } finally {
      if (ordinary) this.turn = undefined;
    }
    let outcome = this.outcome(session, thrown);
    if (answers && remindedAt !== undefined) this.log(answers.result(remindedAt, outcome.result));
    if (ordinary && !failed) {
      if (remindedAt === undefined && outcome.result === "done" && this.config.turnFold && called && !spoke && !this.stopping) {
        asked = true;
        const asking = this.outcome(session, await this.ask(session, recorder.turnId));
        if (asking.result !== "done") {
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
      const { afterCommit } = options;
      await this.backend.turnEnd({
        turn_id: recorder.turnId,
        ...outcome,
        ...(ordinary ? { seqs: turn.seqs } : { night }),
        ...(context === undefined ? {} : { context }),
      }, afterCommit && (() => afterCommit(recorder.turnId)));
    } catch (error) {
      this.log(`turn end not sent: ${failure(error)}`);
    }
    if (failed) {
      for (const seq of turn.seqs) this.taken.delete(seq);
    } else {
      await this.ack(turn.seqs);
    }
    return { ...outcome, turn_id: recorder.turnId };
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
    if (last?.stopReason === "error") return { result: "failed", reason: modelError(last) };
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
    const report = made ? undefined : await this.nightly(event.seq, payload.review_date);
    try {
      await this.backend.rotated({ seq: event.seq, ...report });
    } catch (error) {
      this.log(`rotation not sent: ${failure(error)}`);
      this.taken.delete(event.seq);
      return;
    }
    // Without a new session the event is not acked: it comes again, and the night is run again.
    if (report && report.stages.session.result !== "done") {
      this.taken.delete(event.seq);
      return;
    }
    await this.ack([event.seq]);
  }

  /** Each step is attempted even if one before it failed (ADR-0044). */
  private async nightly(seq: number, reviewDate?: string): Promise<{ stages: NightStages; memory_reads?: MemoryReadsSnapshot }> {
    const nightStarted = new Date().toISOString();
    const { memoryDir, identity, promptLayerTargetBytes, nightCarryDays } = this.config;
    const manager = this.session!.session.sessionManager;
    const today = nightStarted.slice(0, 10);
    const previousReads = this.state?.memoryReads ?? [];
    let snapshot: MemoryReadsSnapshot | undefined;
    try {
      snapshot = { day: today, files: await memoryReads(memoryDir, manager.getCwd(), manager.getEntries(), previousReads, today) };
    } catch {
      this.log("night memory reads could not be collected");
    }
    const reads = snapshot?.files ?? previousReads;
    const reflection = await this.nightStage("reflection", async () => {
      const layer = await alwaysReadLayer(memoryDir, promptLayerTargetBytes);
      manager.appendCustomEntry(NIGHT_REFLECTION, true);
      try {
        return stageOf(await this.turnOf(this.session!.session, reflectionInput(this.places, layer), { night: { seq, stage: "reflection" } }));
      } finally {
        manager.appendCustomEntry(NIGHT_REFLECTION, false);
      }
    });
    const { file: main, verifierMemory, curatorMemory, unverifiedRecords = [] } = this.state!;
    const header = manager.getHeader();
    // Collect originals for carry-over even if the verifier cannot start.
    const originals = header
      ? await this.subAgents.recordsSince(Date.parse(header.timestamp)).then((subAgents) => ({ subAgents }), (error: unknown) => ({ error }))
      : { error: new Error("The daytime session has no header.") };
    const current: DaytimeRecords = {
      main, started: header?.timestamp ?? nightStarted, ended: nightStarted,
      subAgents: "subAgents" in originals ? originals.subAgents : unverifiedRecords.find((record) => record.main === main)?.subAgents ?? [],
    };
    // A retry of the same switch still has the same daytime session.
    const previous = unverifiedRecords.filter((record) => record.main !== main);
    const cutoff = utcDay(nightStarted) - nightCarryDays;
    const carried = previous.filter(({ ended }) => utcDay(ended) >= cutoff);
    const droppedRecords = previous.length - carried.length;
    if (droppedRecords) this.log(`night verifier: dropped ${droppedRecords} unverified daytime record(s) older than ${nightCarryDays} UTC days`);

    let verifier = await this.nightStage(VERIFIER, async () => {
      if ("error" in originals) throw originals.error;
      const transcripts = [current, ...carried].flatMap(({ main, subAgents }) => [main, ...subAgents]);
      const memory = await memorySnapshot(memoryDir);
      return this.nightWorker(seq, VERIFIER, verifierSystemPrompt(identity, this.places, memory),
        verifierInput(this.places, current, carried, memoryChanges(verifierMemory, memory), verifierMemory !== undefined), { transcripts });
    });
    const lastReviews = new Map(this.state!.lastTopicReviews);
    let overTarget: NightStages["curator"]["always_read_over_target"];
    const curate = async (review?: { kind: "content"; date: string } | { kind: "structure" }) => {
      const moves = new MemoryMoves();
      let topics: string[] = [];
      const result = await this.nightStage("curator", async () => {
        const memory = await memorySnapshot(memoryDir);
        const map = await memoryMap(memoryDir, memory, reads, today);
        const system = curatorSystemPrompt(identity, this.places, memory);
        if (review?.kind === "structure") {
          return this.nightWorker(seq, "curator", system, reviewStructureInput(this.places, memory, map), { moves });
        }
        const layer = await alwaysReadLayer(memoryDir, promptLayerTargetBytes);
        if (layer.overTarget) overTarget = { total_bytes: layer.total, target_bytes: layer.target };
        if (review?.kind === "content") {
          const paths = memory.map(({ path }) => path);
          topics = reviewTopics(memory, lastReviews, this.config.reviewTopicMaxBytes);
          return this.nightWorker(seq, "curator", system,
            reviewContentInput(review.date, topics, weekDiary(paths, review.date), planArchive(paths, review.date), layer, map), { moves });
        }
        return this.nightWorker(seq, "curator", system,
          curatorInput(memory, memoryChanges(curatorMemory, memory), curatorMemory !== undefined, layer, map), { moves });
      });
      if (review?.kind === "content" && result.result === "done") {
        for (const path of topics) lastReviews.set(path, review.date);
      }
      // Snapshot dates at the origins before applying any renames. Changes on a failed turn are not rolled back.
      const relocated = [...moves.history].flatMap(([to, [from]]) => from === undefined ? [] : [{ to, from, date: lastReviews.get(from) }]);
      for (const { from, to } of relocated) {
        lastReviews.delete(from);
        lastReviews.delete(to);
      }
      for (const { to, date } of relocated) if (date !== undefined) lastReviews.set(to, date);
      return result;
    };
    let curator: NightStages["curator"];
    if (reviewDate === undefined) {
      curator = await curate();
    } else {
      const content = await curate({ kind: "content", date: reviewDate });
      const structure = await curate({ kind: "structure" });
      const turn_id = structure.turn_id ?? content.turn_id;
      const reasons = [...new Set([content.reason, structure.reason].filter(Boolean))];
      // Keep the aggregate and last turn ID for older backends.
      curator = {
        review: { content, structure },
        result: content.result === "done" && structure.result === "done" ? "done" : "failed",
        ...(reasons.length ? { reason: reasons.join("; ") } : {}),
        ...(turn_id ? { turn_id } : {}),
      };
    }

    // Use the memory left by the whole curator stage, so its edits are not
    // mistaken for daytime changes after a successful verification.
    const after = verifier.result === "done" || curator.result === "done" || lastReviews.size > 0
      ? await memorySnapshot(memoryDir).catch((error: unknown) => {
        const reason = `The night baseline could not be taken: ${failure(error)}`;
        this.log(reason);
        if (verifier.result === "done") verifier = { ...verifier, result: "failed", reason };
        if (curator.result === "done") curator = { ...curator, result: "failed", reason };
        return undefined;
      })
      : undefined;
    if (after && lastReviews.size) {
      const paths = new Set(after.map(({ path }) => path));
      for (const path of lastReviews.keys()) if (!paths.has(path)) lastReviews.delete(path);
    }
    await this.keepNightState({
      ...(after !== undefined && verifier.result === "done" ? { verifierMemory: after } : {}),
      ...(after !== undefined && curator.result === "done" ? { curatorMemory: after } : {}),
      unverifiedRecords: verifier.result === "done" ? [] : [...carried, current],
      ...(this.state!.lastTopicReviews || lastReviews.size ? { lastTopicReviews: [...lastReviews] } : {}),
    });

    let session: NightStage;
    try {
      const state: SessionState = { ...this.state!, file: await newSessionFile(this.config), nightly: seq, memoryReads: reads };
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
    return {
      stages: {
        reflection,
        verifier: { ...verifier, ...(droppedRecords ? { dropped_records: droppedRecords } : {}) },
        curator: { ...curator, ...(overTarget === undefined ? {} : { always_read_over_target: overTarget }) },
        session,
      },
      ...(snapshot === undefined ? {} : { memory_reads: snapshot }),
    };
  }

  /** Keep night work independently of whether a new daytime session opens. */
  private async keepNightState(update: Partial<Pick<SessionState, "verifierMemory" | "curatorMemory" | "unverifiedRecords" | "lastTopicReviews">>): Promise<void> {
    const state = { ...this.state!, ...update };
    this.state = state;
    await writeState(this.config, state).catch((error: unknown) => {
      // The rotation's write can still persist the checkpoint with the new session.
      this.log(`night checkpoint not saved: ${failure(error)}`);
    });
  }

  private async nightStage(stage: NightTurnStage, run: () => Promise<NightTurnReport>): Promise<NightTurnReport> {
    try {
      return await run();
    } catch (error) {
      const reason = `The ${stage} could not run: ${failure(error)}`;
      this.log(reason);
      return { result: "failed", reason };
    }
  }

  private async nightWorker(
    seq: number, stage: Exclude<NightTurnStage, "reflection">, system: string, input: string,
    { transcripts, moves }: { transcripts?: string[]; moves?: MemoryMoves },
  ): Promise<NightTurnReport> {
    const tools = nightTools(this.config, transcripts, moves);
    const { session } = await openSession(
      { ...this.setup, tools, extensions: [], fileOnly: true }, system,
      nightManager(this.config, stage), this.config.memoryDir,
    );
    try {
      return stageOf(await this.turnOf(session, input, {
        night: { seq, stage },
        ...(moves === undefined ? {} : { afterCommit: (turnId) => this.repairMoves(moves, { seq, turn_id: turnId }) }),
      }));
    } finally {
      session.dispose();
    }
  }

  private async repairMoves(moves: MemoryMoves, night: { seq: number; turn_id: string }): Promise<void> {
    const report = (error: unknown) => this.log(`night memory reference repair: ${failure(error)}`);
    try {
      const repair = await repairMemoryReferences(this.config.memoryDir, moves, report);
      if (repair.paths.length > 0) await this.backend.commitMemoryRepairs({ ...repair, night });
    } catch (error) {
      report(error);
    }
  }
}
