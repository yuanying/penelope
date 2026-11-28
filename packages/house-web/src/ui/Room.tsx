import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

import type { HouseActor, HousePersonView, HouseSpeech } from "@penelope/contract";

import type { ConversationLog } from "../model/log.ts";
import type { Line, Said } from "../model/session.ts";
import { BackIcon, EnterIcon, EyeIcon, ReconnectIcon } from "./icons.tsx";
import { isAsleep, keyOf, ResidentAvatar, ResidentCard, ResidentStack, type Shown } from "./residents.tsx";
import { Speak, type Writing } from "./Speak.tsx";
import { Timeline } from "./Timeline.tsx";
import { UnreadBadge } from "./UnreadBadge.tsx";
import { timeOf, withUnread, words } from "./words.ts";

type Room = HousePersonView["rooms"][number];

export function LineNotice({ line, onRetry }: { line: Line; onRetry: () => void }) {
  if (line.kind === "down") return <Banner status="warning" title={words.down} description={words.downBody} icon={<Icon icon={ReconnectIcon} />} />;
  if (line.kind === "refused") {
    return (
      <Banner
        status="error"
        title={words.refused}
        description={words.downBody}
        endContent={<Button label={words.retry} variant="secondary" size="sm" onClick={onRetry} />}
      />
    );
  }
  return null;
}

export type ConversationPane = {
  you: HousePersonView["you"];
  residents: ReadonlyMap<string, Shown>;
  undelivered: ReadonlyMap<string, readonly HouseActor[]>;
  phone: boolean;
  narrow: boolean;
  line: Line;
  onRetry: () => void;
  heading: RefObject<HTMLHeadingElement | null>;
  log: ConversationLog | undefined;
  onOlder: () => Promise<void>;
};

export function ConversationRecord({ log, label, empty, scroller, bottom, ...timeline }: { log: ConversationLog | undefined; label: string; empty: string; scroller: RefObject<HTMLDivElement | null>; bottom: ReactNode } & Pick<ConversationPane, "you" | "residents" | "undelivered" | "narrow"> & { onOlder: () => Promise<void> }) {
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    const composer = dock.current;
    if (!element || !composer) return;
    let height = composer.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = composer.offsetHeight;
      const growth = next - height;
      height = next;
      // The dock is part of the scroll height. Check how close the reader was before it grew.
      if (growth !== 0 && element.scrollHeight - element.scrollTop - element.clientHeight - Math.max(0, growth) < 160) {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [scroller]);

  return (
    <div className="room-talk">
      <ChatLayout
        ref={scroller}
        density="spacious"
        aria-label={label}
        composer={<div className="room-bottom" ref={dock}>{bottom}</div>}
        emptyState={log?.whole !== undefined ? <EmptyState title={empty} headingLevel={3} /> : <p className="room-reading">{words.reading}</p>}
      >
        {log !== undefined && log.events.length > 0 ? <Timeline log={log} scroller={scroller} {...timeline} /> : null}
      </ChatLayout>
    </div>
  );
}

export type MyRoomProps = ConversationPane & {
  room: Room | undefined;
  access: "member" | "entering" | "read-only";
  entryNotice?: ReactNode;
  touch: boolean;
  /** What is written for this room, and a way to change it that still means this room after the person left it. */
  writing: Writing;
  onWriting: (change: (writing: Writing) => Writing) => void;
  onSay: (speech: HouseSpeech) => Promise<Said>;
  onLeave: () => void;
  onBack: () => void;
};

export function MyRoom({ room, access, entryNotice, log, touch, writing, onWriting, onSay, onOlder, onLeave, onBack, heading, phone, line, onRetry, ...shared }: MyRoomProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState(false);
  const back = phone ? <IconButton icon={<Icon icon={BackIcon} />} label={words.backToPlan} variant="ghost" size="lg" onClick={onBack} /> : null;
  if (room === undefined) {
    return (
      <section className="room" id="conversation" aria-label={words.myRoom}>
        <header className="room-head">
          {back}
          <div className="room-title">
            <h2 ref={heading} tabIndex={-1}>
              {words.nowhereTitle}
            </h2>
          </div>
        </header>
        <div className="room-nowhere">
          <p>{words.nowhereBody}</p>
          {phone ? <Button label={words.openPlan} variant="primary" size="lg" onClick={onBack} /> : null}
          <LineNotice line={line} onRetry={onRetry} />
        </div>
      </section>
    );
  }
  const member = access === "member";
  const others = room.occupants.filter((resident) => !(resident.kind === "person" && resident.id === shared.you.id));
  return (
    <section className="room" id="conversation" aria-label={member ? words.myRoom : words.readOnlyRoom}>
      <header className="room-head">
        {back}
        <div className="room-title">
          <h2 ref={heading} tabIndex={-1}>
            {room.name}
          </h2>
          <p>{phone ? room.occupants.map((resident) => `${resident.name}${isAsleep(resident) ? words.asleepMark : ""}`).join("・") : room.description}</p>
        </div>
        {!member ? null : phone ? (
          <button type="button" className="room-people" aria-label={words.showResidents} onClick={() => setSheet(true)}>
            <ResidentStack residents={room.occupants} size={32} max={4} />
          </button>
        ) : (
          <>
            <ResidentStack residents={room.occupants} size={32} max={6} />
            <Button label={words.leave} variant="secondary" isDisabled={line.kind !== "open"} onClick={onLeave} />
          </>
        )}
      </header>
      <ConversationRecord
        log={log}
        label={words.roomLog(room.name)}
        empty={words.emptyRoom}
        scroller={scroller}
        onOlder={onOlder}
        {...shared}
        bottom={
          <>
            <LineNotice line={line} onRetry={onRetry} />
            <div className="room-entry-status" role="status">
              {entryNotice ?? (member ? null : <p className="room-reading">{access === "entering" ? words.entering : words.readOnlyBody}</p>)}
            </div>
            {member ? (
              <Speak key={room.id} target={{ kind: "room", name: room.name, others }} online={line.kind === "open"} touch={touch} writing={writing} onWriting={onWriting} onSay={onSay} />
            ) : null}
          </>
        }
      />
      {phone && member ? (
        <BottomSheet isOpen={sheet} onOpenChange={setSheet} label={words.residentsOf(room.name)}>
          <div className="room-sheet">
            <div className="room-sheet-head">
              <h3>{room.name}</h3>
              <p>{room.description}</p>
            </div>
            <ul className="residents" role="list">
              {room.occupants.map((resident) => (
                <ResidentCard key={keyOf(resident)} resident={resident} self={resident.kind === "person" && resident.id === shared.you.id} />
              ))}
            </ul>
            <Button
              label={words.leave}
              variant="secondary"
              size="lg"
              width="100%"
              isDisabled={line.kind !== "open"}
              onClick={() => {
                setSheet(false);
                onLeave();
              }}
            />
          </div>
        </BottomSheet>
      ) : null}
    </section>
  );
}

export type PeekRoomProps = ConversationPane & {
  room: Room;
  mine: Room | undefined;
  /** The person's own room is hidden while this one is looked into. */
  swapped: boolean;
  unread: number;
  onEnter: () => void;
  onClose: () => void;
  onBackToMine: () => void;
};

export function PeekRoom({ room, log, mine, swapped, unread, onOlder, onEnter, onClose, onBackToMine, heading, phone, line, onRetry, ...shared }: PeekRoomProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const alreadyIn = mine?.id === room.id;
  const full = room.capacity !== null && room.occupants.length >= room.capacity;
  const backLabel = mine === undefined ? "" : (alreadyIn ? words.openTalkOf(mine.name) : words.backTo(mine.name));
  return (
    <section className="room room-peek" aria-label={words.peekedRoom}>
      <header className="room-head">
        {phone ? <IconButton icon={<Icon icon={BackIcon} />} label={words.stopPeeking} variant="ghost" size="lg" onClick={onClose} /> : null}
        <div className="room-title">
          <h2 ref={heading} tabIndex={-1}>
            <span className="room-title-name">{room.name}</span>
            <Badge variant="info" label={words.peeking} icon={<Icon icon={EyeIcon} size="xsm" color="inherit" />} />
          </h2>
          <p>{room.description}</p>
        </div>
        {phone ? null : <IconButton icon={<Icon icon="close" />} label={words.stopPeeking} variant="ghost" onClick={onClose} />}
      </header>
      <ul className="room-strip" role="list">
        {room.occupants.length === 0 ? <li>{words.nobody}</li> : null}
        {room.occupants.map((resident) => {
          const status = resident.kind === "agent" ? resident.status : null;
          return (
            <li key={keyOf(resident)}>
              <ResidentAvatar resident={resident} size={24} />
              <b translate="no">{resident.name}</b>
              {!resident.connected ? (
                <span>{words.disconnected}</span>
              ) : status && status.sleep.state !== "awake" ? (
                <span>{words.asleepUntil(timeOf(status.sleep.wake_at))}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ConversationRecord
        log={log}
        label={words.roomLog(room.name)}
        empty={words.emptyRoom}
        scroller={scroller}
        onOlder={onOlder}
        {...shared}
        bottom={
          <>
            <LineNotice line={line} onRetry={onRetry} />
            <div className="peek-bar">
              <p className="peek-note">
                <Icon icon={EyeIcon} size="sm" color="inherit" />
                <span>{words.peekNote}</span>
              </p>
              <div className="peek-actions">
                {alreadyIn ? null : full ? (
                  <span className="peek-full">{words.fullNoEntryOf(room.capacity ?? 0)}</span>
                ) : (
                  <Button
                    label={words.enterHere}
                    variant="primary"
                    size={phone ? "lg" : "md"}
                    icon={<Icon icon={EnterIcon} size="sm" color="inherit" />}
                    isDisabled={line.kind !== "open"}
                    onClick={onEnter}
                  />
                )}
                {swapped && mine !== undefined ? (
                  <Button
                    label={backLabel}
                    variant="secondary"
                    size={phone ? "lg" : "md"}
                    aria-label={withUnread(backLabel, unread)}
                    onClick={onBackToMine}
                    {...(unread > 0
                      ? {
                          endContent: <UnreadBadge count={unread} />,
                        }
                      : {})}
                  />
                ) : null}
              </div>
            </div>
          </>
        }
      />
    </section>
  );
}
