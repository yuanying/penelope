// Detail pages for a turn, a night, or a sub-agent.
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { type ReactNode, useEffect, useState } from "react";

import type { Activity, MemoryChange, RecordFlowItem, RecordNightResponse, RecordSubAgentResponse, RecordTurn, RecordTurnResponse } from "@penelope/contract";

import { type Api, Refused } from "../model/api.ts";
import { ChevronLeftIcon } from "./icons.tsx";
import { FlowLine } from "./FlowLine.tsx";
import { dateTimeOf, failedStageOf, headlineText, isFresh, nightTitle, nightWarnings, spanOf, stagesOf } from "./record.ts";
import { Counts, writerName } from "./memory/shared.tsx";
import { RecordMark, RecordRowView, StageMark, StageMemory } from "./RecordRow.tsx";
import { hashOf, type RecordPage } from "./route.ts";
import { sizeOf, words } from "./words.ts";

const w = words.record;

type Loaded =
  | { kind: "turn"; data: RecordTurnResponse }
  | { kind: "night"; data: RecordNightResponse }
  | { kind: "sub_agent"; data: RecordSubAgentResponse }
  | { kind: "missing" }
  | { kind: "failed" };

export function RecordDetail({
  api,
  onFail,
  page,
  previousSeenAt,
}: {
  api: Api;
  onFail: (error: unknown) => void;
  page: RecordPage;
  previousSeenAt: string | undefined;
}) {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<Loaded> => {
      switch (page.kind) {
        case "turn":
          return { kind: "turn", data: await api.recordTurn(page.id) };
        case "night":
          return { kind: "night", data: await api.recordNight(page.id) };
        case "sub_agent":
          return { kind: "sub_agent", data: await api.recordSubAgent(page.id) };
      }
    };
    read().then(
      (result) => current && setLoaded(result),
      (error: unknown) => {
        if (!current) return;
        onFail(error);
        setLoaded(error instanceof Refused && error.status === 404 ? { kind: "missing" } : { kind: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [api, page, onFail]);

  return (
    <article className="page-body record-detail">
      <a className="record-back" href={hashOf({ place: "log" })}>
        <ChevronLeftIcon width={16} height={16} />
        <span>{w.back}</span>
      </a>
      {loaded === undefined ? null : loaded.kind === "missing" ? (
        <p className="muted">{w.notFound}</p>
      ) : loaded.kind === "failed" ? (
        <Banner status="error" title={w.failedToRead} />
      ) : loaded.kind === "turn" ? (
        <TurnPage api={api} data={loaded.data} />
      ) : loaded.kind === "night" ? (
        <NightPage data={loaded.data} />
      ) : (
        <SubAgentPage api={api} onFail={onFail} first={loaded.data} previousSeenAt={previousSeenAt} />
      )}
    </article>
  );
}

/** The title, how it went in a mark and words, and the reason of a failure. */
function Head({ title, mono = false, mark, result, reason, bad }: { title: string; mono?: boolean; mark: ReactNode; result: string; reason?: string | undefined; bad: boolean }) {
  return (
    <>
      <div className="record-detail-head">
        <Heading level={1}>{mono ? <Code color="inherit">{title}</Code> : title}</Heading>
        <span className="record-result" data-bad={bad || undefined}>
          {mark}
          <span>{result}</span>
        </span>
      </div>
      {bad && reason !== undefined && reason !== "" ? <Banner status="error" title={reason} /> : null}
    </>
  );
}

function Facts({ facts, memory, origin }: { facts: Array<[string, string]>; memory?: readonly MemoryChange[]; origin?: RecordPage }) {
  return (
    <dl className="record-facts">
      {facts.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      {memory && memory.length > 0 && origin ? <div className="record-memory-facts">
        <dt>記憶</dt>
        {/* A night has a change for each stage: its name tells them apart. */}
        {memory.map((change) => <dd key={change.id}><a href={hashOf({ place: "memory", page: { kind: "change", id: change.id, from: origin } })}>{origin.kind === "night" ? `${writerName(change.writer)} ・ ` : ""}<Counts of={change} /></a></dd>)}
      </div> : null}
    </dl>
  );
}

const TURN_RESULTS = { done: w.done, failed: w.failed, stopped: w.stopped, running: w.running, unknown: w.unknown } as const;
const TURN_MARKS = { done: "ok", failed: "fail", stopped: "stop", running: "running", unknown: "unknown" } as const;

function turnFacts(turn: RecordTurn): Array<[string, string]> {
  return [
    [w.facts.time, spanOf(turn.started_at, turn.ended_at, turn.seconds)],
    [w.facts.who, turn.agent === "main" ? words.main : turn.agent],
    [w.facts.tools, w.toolTimes(turn.tools)],
    [w.facts.replies, w.replyCount(turn.replies)],
  ];
}

function TurnPage({ api, data }: { api: Api; data: RecordTurnResponse }) {
  const { turn, flow, expired } = data;
  return (
    <>
      <Head title={headlineText(turn)} mark={<RecordMark mark={TURN_MARKS[turn.result]} />} result={TURN_RESULTS[turn.result]} reason={turn.reason} bad={turn.result === "failed"} />
      {turn.result !== "failed" && turn.reason !== undefined ? <p className="muted">{turn.reason}</p> : null}
      <Facts facts={turnFacts(turn)} {...(data.memory_change ? { memory: [data.memory_change], origin: { kind: "turn", id: turn.id } } : {})} />
      {expired ? (
        <p className="record-expired">{w.expired}</p>
      ) : (
        <section className="record-section" aria-label={w.flow}>
          <h2>{w.flow}</h2>
          <ol className="flow">
            {flow.map((item, index) => (
              <FlowLine key={index} item={item} result={(call) => <StoredResult api={api} turn={turn.id} call={call} all={flow} />} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

/** A tool's result kept by the record: folded with its size, and read from the backend when it is opened. */
function StoredResult({ api, turn, call, all }: { api: Api; turn: string; call: Extract<Activity, { kind: "tool_call" }>; all: readonly RecordFlowItem[] }) {
  const result = all.find((item): item is Extract<RecordFlowItem, { kind: "tool_result" }> => item.kind === "tool_result" && item.call_id === call.call_id);
  const [output, setOutput] = useState<{ text: string } | { gone: true } | { failed: true } | undefined>(undefined);
  if (result === undefined) return null;
  const label = (result.is_error ? w.openErrorResult : w.openResult)(result.lines, sizeOf(result.bytes));
  const open = (isOpen: boolean) => {
    if (!isOpen || (output !== undefined && !("failed" in output))) return;
    api.recordResult(turn, call.call_id).then(
      (answer) => setOutput({ text: answer.output }),
      (error: unknown) => setOutput(error instanceof Refused && error.status === 404 ? { gone: true } : { failed: true }),
    );
  };
  return (
    <Collapsible defaultIsOpen={false} chevronPosition="start" onOpenChange={open} trigger={<span className="flow-label">{label}</span>}>
      {output === undefined ? null : "text" in output ? (
        <CodeBlock code={output.text} maxHeight={220} width="100%" isWrapped size="sm" hasLanguageLabel={false} />
      ) : (
        <p className="muted">{"gone" in output ? w.resultGone : w.resultFailed}</p>
      )}
    </Collapsible>
  );
}

function NightPage({ data }: { data: RecordNightResponse }) {
  const { night, turns } = data;
  const warnings = nightWarnings(night);
  const failed = failedStageOf(night);
  const result = night.result === "failed" && failed !== undefined ? w.stageFailed(failed.name) : night.result === "unknown" ? w.nightUnknown : w.nightDone;
  const facts: Array<[string, string]> = [[w.facts.time, spanOf(night.started_at, night.ended_at, night.seconds)]];
  if (night.scheduled_at !== undefined) facts.push([w.facts.due, dateTimeOf(night.scheduled_at)]);
  return (
    <>
      <Head title={nightTitle(night)} mark={<RecordMark mark={night.result === "failed" ? "fail" : "night"} />} result={result} reason={failed?.reason} bad={night.result === "failed"} />
      <Facts facts={facts} {...(data.memory_changes?.length ? { memory: data.memory_changes, origin: { kind: "night", id: night.id } } : {})} />
      {warnings === undefined ? null : <p className="record-note">{warnings}</p>}
      <ol className="record-steps">
        {stagesOf(night).map((stage, index) => {
          const { review } = stage;
          const turn = stage.key === "session" ? undefined : turns[stage.key];
          const tail = ` ・ ${w.stageWord[stage.result]}`;
          return (
            <li key={stage.key} className="record-step" data-result={stage.result}>
              <span className="record-step-head">
                <StageMark result={stage.result} size={16} />
                <span>
                  {index + 1}. {stage.name}
                  {tail}
                </span>
                <StageMemory stage={stage} />
              </span>
              {review !== undefined ? (
                <ul className="record-steps record-review">
                  {(["content", "structure"] as const).map((phase) => {
                    const report = review[phase];
                    const reviewTurn = turns[phase];
                    return (
                      <li key={phase} className="record-step" data-result={report.result}>
                        <span className="record-step-head">
                          <StageMark result={report.result} />
                          <span>{w.review[phase]} ・ {w.stageWord[report.result]}</span>
                          <StageMemory stage={{ ...report, key: "curator", name: w.review[phase] }} />
                        </span>
                        {report.reason ? <span className="record-note">{report.reason}</span> : null}
                        {reviewTurn === undefined ? null : (
                          <ul className="record-rows">
                            <RecordRowView row={reviewTurn} />
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : turn === undefined ? null : (
                <ul className="record-rows">
                  <RecordRowView row={turn} />
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

function SubAgentPage({
  api,
  onFail,
  first,
  previousSeenAt,
}: {
  api: Api;
  onFail: (error: unknown) => void;
  first: RecordSubAgentResponse;
  previousSeenAt: string | undefined;
}) {
  const sub = first.sub_agent;
  const [turns, setTurns] = useState(first.turns);
  const [before, setBefore] = useState(first.before);
  const [reading, setReading] = useState(false);
  const facts: Array<[string, string]> = [[w.facts.purpose, sub.purpose]];
  if (sub.started_at !== undefined) facts.push([w.facts.started, dateTimeOf(sub.started_at)]);
  if (sub.closed_at !== undefined) facts.push([w.facts.closed, dateTimeOf(sub.closed_at)]);
  facts.push([w.facts.turns, w.subTurnFacts(sub.turns, sub.failed_turns)]);
  const more = async () => {
    if (before === undefined) return;
    setReading(true);
    try {
      const page = await api.recordSubAgent(sub.agent, before);
      setTurns((now) => [...now, ...page.turns.filter((t) => !now.some((n) => n.id === t.id))]);
      setBefore(page.before);
    } catch (error) {
      onFail(error);
    } finally {
      setReading(false);
    }
  };
  return (
    <>
      <Head title={sub.agent} mono mark={<RecordMark mark="sub" />} result={sub.closed_at === undefined ? w.open : w.closed} bad={false} />
      <Facts facts={facts} />
      <section className="record-section" aria-label={w.subTurns(sub.turns)}>
        <h2>{w.subTurns(sub.turns)}</h2>
        <ul className="record-rows">
          {turns.map((turn) => (
            <RecordRowView key={turn.id} row={turn} showWho={false} fresh={isFresh(turn, previousSeenAt)} />
          ))}
        </ul>
        {before === undefined ? null : (
          <span>
            <Button label={w.moreTurns(Math.max(0, sub.turns - turns.length))} variant="secondary" isLoading={reading} onClick={() => void more()} />
          </span>
        )}
      </section>
    </>
  );
}
