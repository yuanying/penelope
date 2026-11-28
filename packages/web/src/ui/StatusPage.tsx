import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { useCallback, useEffect, useState } from "react";

import type { AgentStatus, SubAgent } from "@penelope/contract";

import { type Api, Unauthorized } from "../model/api.ts";
import { durationOf } from "./record.ts";
import { hashOf } from "./route.ts";
import { words } from "./words.ts";

const SLEEP = { awake: "起きている", falling_asleep: "眠りに入るところ", asleep: "眠っている" } as const;
const when = (at: string) => new Date(at).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });

export function StatusPage({ api, onUnauthorized }: { api: Api; onUnauthorized: () => void }) {
  const [snapshot, setSnapshot] = useState<{ status: AgentStatus; agents: SubAgent[] }>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const read = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [status, { agents }] = await Promise.all([api.status(), api.agents()]);
      setSnapshot({ status, agents });
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api, onUnauthorized]);
  useEffect(() => { void read(); }, [read]);

  return (
    <div className="page">
      <section className="page-body" aria-label={words.places.status}>
        <div className="status-toolbar">
          <Heading level={1}>{words.places.status}</Heading>
          <Button label="読み直す" variant="secondary" isDisabled={loading} onClick={() => void read()} />
        </div>
        {failed && <Banner status="error" title="状態を読み込めませんでした。" />}
        {loading && snapshot === undefined && <p role="status" className="muted">読み込み中…</p>}
        {snapshot && <>
          <MainStatus status={snapshot.status} />
          <section aria-label="サブエージェント">
            <Heading level={2}>サブエージェント</Heading>
            {snapshot.agents.length === 0 ? <p className="muted">開いているサブエージェントはいません。</p> : (
              <ul className="status-agents">
                {snapshot.agents.map((agent) => (
                  <li key={agent.agent}>
                    <a href={hashOf({ place: "log", page: { kind: "sub_agent", id: agent.agent } })}>{agent.agent}</a>
                    <p>{agent.purpose}</p>
                    <p className="muted">
                      {agent.state === "thinking" ? "作業中" : "待機中"}（{when(agent.state_since)} から） ・ 開始 {when(agent.started_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>}
      </section>
    </div>
  );
}

function MainStatus({ status }: { status: AgentStatus }) {
  return (
    <section aria-label="本体の状態">
      <Heading level={2}>本体の状態</Heading>
      <dl className="record-facts">
        <div><dt>眠り</dt><dd>{SLEEP[status.sleep.state]}</dd></div>
        {status.sleep.state !== "awake" && <div><dt>起床予定</dt><dd>{when(status.sleep.wake_at)}</dd></div>}
        <div><dt>眠気</dt><dd>{status.sleepiness} / 100</dd></div>
        <div><dt>起きてから</dt><dd>{durationOf(status.awake_seconds)}</dd></div>
        {status.context && <div><dt>コンテキスト</dt><dd>{status.context.tokens.toLocaleString()} / {status.context.context_window.toLocaleString()} トークン</dd></div>}
        <div><dt>気分</dt><dd>{status.mood ?? "未設定"}</dd></div>
      </dl>
    </section>
  );
}
