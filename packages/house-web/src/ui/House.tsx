import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import type { HousePersonView } from "@penelope/contract";

import { myRoom, type Session, type Snapshot, unread } from "../model/session.ts";
import { Plan } from "./Plan.tsx";
import { residentsOf } from "./residents.tsx";
import { LineNotice, MyRoom, PeekRoom } from "./Room.tsx";
import { useRoute } from "./route.ts";
import { NOTHING_WRITTEN, type Writing } from "./Speak.tsx";
import { words } from "./words.ts";

const PHONE = "(max-width: 767px)";
/** From this width a room looked into stands beside the person's own. Below it, it takes its place. */
const WIDE = "(min-width: 1200px)";
/** No keyboard to hold Shift on: Enter is a new line and the button sends. */
const TOUCH = "(pointer: coarse)";

type FocusTarget = "plan" | "room" | "peek" | "field" | "opener";

export function House({ session, snapshot, house }: { session: Session; snapshot: Snapshot; house: HousePersonView }) {
  const phone = useMediaQuery(PHONE);
  const wide = useMediaQuery(WIDE);
  const touch = useMediaQuery(TOUCH) || phone;
  const [route, go] = useRoute();
  const [entryRoom, setEntryRoom] = useState<string>();
  const [writings, setWritings] = useState<ReadonlyMap<string, Writing>>(new Map());
  const writers = useRef(new Map<string, (change: (writing: Writing) => Writing) => void>());
  /** The way to change what is written for one room: the same function for the same room, whoever calls it later. */
  const writerOf = (room: string) => {
    const held = writers.current.get(room);
    if (held) return held;
    const writer = (change: (writing: Writing) => Writing) => setWritings((now) => new Map(now).set(room, change(now.get(room) ?? NOTHING_WRITTEN)));
    writers.current.set(room, writer);
    return writer;
  };

  const mine = house.rooms.find(({ id }) => id === myRoom(snapshot));
  const peeked = route.at === "peek" ? house.rooms.find(({ id }) => id === route.room) : undefined;
  const swapped = peeked !== undefined && (phone || !wide || peeked.id === mine?.id);
  const selected = route.at === "talk" ? house.rooms.find(({ id }) => id === route.room) : undefined;
  const conversation = selected ?? mine;
  const notice = snapshot.notice;
  const entryFailed = notice?.kind === "full" || notice?.kind === "enter-failed";
  if (entryRoom !== undefined && (entryRoom === mine?.id || (entryFailed && notice.room === entryRoom))) {
    setEntryRoom(undefined);
  }
  const access =
    conversation !== undefined && conversation.id === mine?.id ? "member"
    : entryRoom !== undefined && entryRoom === conversation?.id ? "entering"
    : "read-only";
  const talkShown = access === "member" && (phone ? route.at === "talk" : !swapped);
  const count = unread(snapshot);
  const online = snapshot.line.kind === "open";

  useEffect(() => {
    document.title = house.name;
  }, [house.name]);
  const viewed = peeked?.id ?? selected?.id;
  useEffect(() => session.show(viewed), [session, viewed]);
  // A tab in the background has shown nothing.
  const myLog = mine === undefined ? undefined : snapshot.logs.get(mine.id);
  const newest = myLog?.events.at(-1)?.id;
  useEffect(() => {
    const see = () => {
      if (talkShown && document.visibilityState === "visible") session.see();
    };
    see();
    document.addEventListener("visibilitychange", see);
    return () => document.removeEventListener("visibilitychange", see);
  }, [session, talkShown, newest]);

  const root = useRef<HTMLElement>(null);
  const planHeading = useRef<HTMLHeadingElement>(null);
  const dock = useRef<HTMLButtonElement>(null);
  const roomHeading = useRef<HTMLHeadingElement>(null);
  const peekHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  const wanted = useRef<FocusTarget | undefined>(undefined);
  useEffect(() => {
    const target = wanted.current;
    if (target === undefined) return;
    const from = opener.current;
    const element =
      target === "plan" ? planHeading.current
      : target === "room" ? roomHeading.current
      : target === "peek" ? peekHeading.current
      : target === "field" ? (root.current?.querySelector<HTMLElement>('#conversation [contenteditable="true"]') ?? roomHeading.current)
      : from instanceof HTMLElement && from.isConnected && from.closest("[inert]") === null ? from : planHeading.current;
    if (!element) return;
    wanted.current = undefined;
    element.focus();
  });
  // The focus is given after a render. Asking for it has to bring one about: what was asked for may be on the
  // screen already, and then nothing else would.
  const [, rendered] = useReducer((count: number) => count + 1, 0);
  const want = (target: FocusTarget) => {
    wanted.current = target;
    rendered();
  };
  const open = (target: FocusTarget) => {
    opener.current = document.activeElement;
    want(target);
  };

  const peek = (room: string) => {
    if (peeked === undefined) open("peek");
    else want("peek");
    go({ at: "peek", room });
  };
  const toPlan = () => {
    want("opener");
    go({ at: "plan" });
  };
  const openTalk = () => {
    if (phone) open("room");
    else want("field");
    go({ at: "talk" });
  };
  const backFromNotice = () => {
    session.dismiss();
    want("plan");
    go({ at: "plan" });
  };
  const enter = (room: string) => {
    setEntryRoom(room);
    want("room");
    go({ at: "talk", room }, route.at === "peek");
    void session.enter(room);
  };
  const leave = () => {
    want(phone ? "plan" : "room");
    if (phone) go({ at: "plan" });
    else if (route.at === "talk" && route.room !== undefined) go({ at: "talk" }, true);
    void session.leave();
  };
  const older = useCallback((room: string) => session.older(room), [session]);

  const residents = residentsOf(house);
  const shared = { you: house.you, residents, undelivered: snapshot.undelivered, phone, line: snapshot.line, onRetry: () => session.retry() };
  const nameOf = (room: string) => house.rooms.find(({ id }) => id === room)?.name ?? room;
  const noticeInRoom = entryFailed && notice.room === selected?.id;
  const noticeTitle =
    notice === undefined ? undefined
    : notice.kind === "return-failed" ? words.returnFailed(nameOf(notice.room))
    : notice.kind === "full" ? words.enterFull(nameOf(notice.room))
    : notice.kind === "enter-failed" ? words.enterFailed(nameOf(notice.room))
    : notice.kind === "failed" ? words.failed
    : words.logoutUnconfirmed;
  const noticeBanner = notice ? (
    <Banner
      status={notice.kind === "failed" || notice.kind === "logout-unconfirmed" || notice.kind === "enter-failed" ? "error" : "warning"}
      title={noticeTitle}
      elevation="med"
      isDismissable
      dismissLabel={words.dismiss}
      onDismiss={() => session.dismiss()}
      {...(notice.kind === "logout-unconfirmed"
        ? { endContent: <Button label={words.logoutAgain} variant="secondary" size="sm" onClick={() => void session.logout()} /> }
        : entryFailed
          ? { endContent: <Button label={words.backToPlan} variant="secondary" size="sm" onClick={backFromNotice} /> }
          : {})}
    />
  ) : undefined;
  const notices = <div className="house-notices" role="status" aria-live="polite">{noticeInRoom ? undefined : noticeBanner}</div>;
  // Past what stands before the conversation on the screen now. On a phone's floor that is the way into it.
  const skip = (
    <a
      className="skip-link"
      href="#conversation"
      onClick={(event) => {
        event.preventDefault();
        const target = peeked !== undefined && swapped ? peekHeading.current : phone && route.at !== "talk" ? (dock.current ?? planHeading.current) : roomHeading.current;
        target?.focus();
      }}
    >
      {words.skip}
    </a>
  );
  const plan = (
    <Plan
      house={house}
      mine={mine?.id}
      peek={peeked?.id}
      online={online}
      phone={phone}
      openTalkFromTile={phone || (selected !== undefined && selected.id !== mine?.id)}
      unread={count}
      lineNotice={<LineNotice line={snapshot.line} onRetry={() => session.retry()} />}
      heading={planHeading}
      dock={dock}
      onPeek={peek}
      onEnter={enter}
      onOpenTalk={openTalk}
      onLogout={() => void session.logout()}
    />
  );
  const myRoomPane = (
    <MyRoom
      {...shared}
      narrow={phone || peeked !== undefined}
      room={conversation}
      access={access}
      entryNotice={noticeInRoom ? noticeBanner : undefined}
      log={conversation === undefined ? undefined : snapshot.logs.get(conversation.id)}
      touch={touch}
      writing={(mine === undefined ? undefined : writings.get(mine.id)) ?? NOTHING_WRITTEN}
      onWriting={writerOf(mine?.id ?? "")}
      onSay={(text, to) => (mine === undefined ? Promise.resolve("refused") : session.say(mine.id, text, to))}
      onOlder={() => (conversation === undefined ? Promise.resolve() : older(conversation.id))}
      onLeave={leave}
      onBack={toPlan}
      heading={roomHeading}
    />
  );
  const peekPane =
    peeked === undefined ? null : (
      <PeekRoom
        {...shared}
        narrow
        room={peeked}
        log={snapshot.logs.get(peeked.id)}
        mine={mine}
        swapped={swapped}
        unread={count}
        onOlder={() => older(peeked.id)}
        onEnter={() => enter(peeked.id)}
        onClose={toPlan}
        onBackToMine={openTalk}
        heading={peekHeading}
      />
    );

  if (phone) {
    const covered = route.at === "talk" || peeked !== undefined;
    return (
      <main ref={root} className="house house-phone">
        {skip}
        {notices}
        <div className="house-plan" inert={covered}>
          {plan}
        </div>
        {peeked !== undefined ? <div className="house-layer">{peekPane}</div> : route.at === "talk" ? <div className="house-layer">{myRoomPane}</div> : null}
      </main>
    );
  }
  return (
    <main ref={root} className={peeked !== undefined && !swapped ? "house house-pc house-side" : "house house-pc"}>
      {skip}
      {notices}
      <div className="house-plan">{plan}</div>
      {peekPane}
      {swapped ? null : myRoomPane}
    </main>
  );
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
