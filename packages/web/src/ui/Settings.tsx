import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { useCallback, useEffect, useId, useState } from "react";

import { modelRef, type ModelSelection, type SettingsResponse, type ThinkingLevel } from "@penelope/contract";

import { type Api, Unauthorized } from "../model/api.ts";

const thinkingNames: Record<ThinkingLevel, string> = {
  off: "オフ", minimal: "最小", low: "低い", medium: "標準", high: "高い", xhigh: "とても高い", max: "最大",
};
const tokens = new Intl.NumberFormat("ja-JP");

export function Settings({ api, onUnauthorized, agentName }: {
  api: Api; onUnauthorized: () => void; agentName: string;
}) {
  const heading = useId();
  const [settings, setSettings] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [failed, setFailed] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const model = settings?.models.find((candidate) => modelRef(candidate) === draft?.model);
  const selectedModel = settings?.models.find((candidate) => modelRef(candidate) === settings.selection?.model);
  const effective = selectedModel ? settings?.selection : settings?.default;
  const removed = settings?.selection && !selectedModel;

  const show = useCallback((next: SettingsResponse) => {
    setSettings(next);
    const initial = next.models.find((m) => modelRef(m) === next.selection?.model) ? next.selection : next.default;
    const capabilities = next.models.find((m) => modelRef(m) === initial?.model)?.thinking_levels;
    const level = initial && capabilities?.includes(initial.thinking) ? initial.thinking : capabilities?.[0];
    setDraft(initial && level ? { model: initial.model, thinking: level } : null);
  }, []);
  const read = useCallback(async () => {
    setFailed(undefined);
    try {
      show(await api.settings());
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed("設定を読み込めませんでした。");
    }
  }, [api, onUnauthorized, show]);
  useEffect(() => { void read(); }, [read]);

  const save = async (selection: ModelSelection) => {
    setSaving(true);
    setFailed(undefined);
    try {
      show(await api.saveSettings(selection));
      setSaved(true);
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed("保存できませんでした。一覧を読み直してから、もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <section className="page-body settings-page" aria-labelledby={heading}>
        <Heading level={1}><span id={heading}>設定</span></Heading>
        <div className="settings-card">
          <Heading level={2}>モデルと思考</Heading>
          <p className="settings-note">保存した設定は、本体・サブエージェント・夜の整理係の次のターンから使われます。</p>
          {failed && <Banner status="error" title={failed} />}
          {settings ? (
            <>
              <div className="settings-current">
                {effective ? (
                  <>
                    <Badge label={selectedModel ? "保存した設定" : "既定"} />
                    <span><code>{effective.model}</code> ・ {selectedModel && !selectedModel.thinking_levels.includes(effective.thinking)
                      ? "思考の深さは Pi が調整します" : thinkingNames[effective.thinking]}</span>
                  </>
                ) : "モデルの情報はまだありません。"}
              </div>
              {removed && settings.models.length > 0 && <Banner status="warning" title={`保存したモデル (${settings.selection?.model}) は利用できません。既定を使います。`} />}
              {settings.models.length > 0 ? (
                <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (draft) void save(draft); }}>
                  <label>
                    モデル
                    <select value={draft?.model ?? ""} disabled={saving} onChange={(event) => {
                      const next = settings.models.find((m) => modelRef(m) === event.target.value);
                      if (!next) return;
                      const level = draft && next.thinking_levels.includes(draft.thinking) ? draft.thinking : next.thinking_levels[0];
                      setDraft(level ? { model: modelRef(next), thinking: level } : null);
                      setSaved(false);
                    }}>
                      <option value="" disabled>モデルを選ぶ</option>
                      {settings.models.map((entry) => <option key={modelRef(entry)} value={modelRef(entry)}>{entry.name} — {modelRef(entry)}</option>)}
                    </select>
                  </label>
                  {model && <p className="settings-note settings-model-detail"><code>{modelRef(model)}</code> ・ {tokens.format(model.context_window)} トークン</p>}
                  <label>
                    思考の深さ
                    <select value={draft?.thinking ?? ""} disabled={!model || saving} onChange={(event) => {
                      const level = model?.thinking_levels.find((entry) => entry === event.target.value);
                      if (draft && level) setDraft({ ...draft, thinking: level });
                      setSaved(false);
                    }}>
                      {model?.thinking_levels.map((level) => <option key={level} value={level}>{thinkingNames[level]}</option>)}
                    </select>
                  </label>
                  <div className="settings-actions">
                    <Button type="submit" label="保存" isLoading={saving} isDisabled={!draft || (settings.selection?.model === draft.model && settings.selection.thinking === draft.thinking)} />
                    {saved && <span role="status">保存しました</span>}
                  </div>
                </form>
              ) : <p className="settings-note">利用できるモデルの一覧を受け取っていません。</p>}
            </>
          ) : !failed && <p role="status">読み込み中…</p>}
          {(failed || settings?.models.length === 0) && <div><Button label="読み直す" variant="secondary" onClick={() => void read()} /></div>}
        </div>
        <div className="settings-card">
          <Heading level={2}>エージェント</Heading>
          <p className="settings-note">名前: {agentName}</p>
        </div>
      </section>
    </div>
  );
}
