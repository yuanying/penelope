import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { useCallback, useEffect, useState } from "react";

import type { AppDevice } from "@penelope/contract";

import { type Api, Unauthorized } from "../model/api.ts";

const date = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });

export function AppDevices({ api, onUnauthorized }: { api: Api; onUnauthorized: () => void }) {
  const [devices, setDevices] = useState<AppDevice[]>();
  const [asked, setAsked] = useState<AppDevice>();
  const [revoking, setRevoking] = useState(false);
  const [failed, setFailed] = useState<string>();

  const read = useCallback(async () => {
    setFailed(undefined);
    try {
      setDevices((await api.appDevices()).devices);
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed("iPhone の端末を読み込めませんでした。");
    }
  }, [api, onUnauthorized]);
  useEffect(() => { void read(); }, [read]);

  const revoke = async (device: AppDevice) => {
    setRevoking(true);
    setFailed(undefined);
    try {
      await api.revokeAppDevice(device.id);
      setDevices((current) => current?.filter((entry) => entry.id !== device.id));
    } catch (error) {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed("失効を確認できませんでした。一覧を読み直してから、もう一度お試しください。");
    } finally {
      setRevoking(false);
      setAsked(undefined);
    }
  };

  return (
    <div className="settings-card">
      <Heading level={2}>iPhone の端末</Heading>
      <p className="settings-note">失効した端末は、もう一度ログインするまでこのエージェントにつながりません。</p>
      {failed && <Banner status="error" title={failed} />}
      {devices === undefined ? !failed && <p role="status">読み込み中…</p> : devices.length === 0 ? (
        <p className="settings-note">ログインしている iPhone はありません。</p>
      ) : (
        <ul className="settings-devices" role="list">
          {devices.map((device) => (
            <li key={device.id} className="settings-current settings-device">
              <div>
                <div>{device.name}</div>
                <p className="settings-note">ログイン: <time dateTime={device.created_at}>{date.format(new Date(device.created_at))}</time></p>
              </div>
              <Button label="失効" aria-label={`${device.name} を失効`} variant="secondary" onClick={() => setAsked(device)} />
            </li>
          ))}
        </ul>
      )}
      {failed && <div><Button label="端末を読み直す" variant="secondary" onClick={() => void read()} /></div>}
      <AlertDialog
        isOpen={asked !== undefined}
        onOpenChange={(open) => { if (!open && !revoking) setAsked(undefined); }}
        title="この端末を失効しますか？"
        description={asked === undefined ? "" : `「${asked.name}」だけがログインし直す必要があります。ほかの端末や Web のログインはそのままです。`}
        actionLabel="失効"
        cancelLabel="戻る"
        isActionLoading={revoking}
        onAction={() => { if (asked !== undefined) void revoke(asked); }}
      />
    </div>
  );
}
