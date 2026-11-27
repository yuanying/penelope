import { Banner } from "@astryxdesign/core/Banner";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { HousePersonView } from "@penelope/contract";

import { myRoom, type Session, type Snapshot, unread } from "../model/session.ts";
import { Plan } from "./Plan.tsx";
import { residentsOf } from "./residents.tsx";
import { LineNotice, MyRoom, PeekRoom } from "./Room.tsx";
import { useRoute } from "./route.ts";
import { type Draft, EMPTY_DRAFT } from "./Speak.tsx";
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
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const mine = house.rooms.find(({ id }) => id === myRoom(snapshot));
  const peeked = route.at === "peek" ? house.rooms.find(({ id }) => id === route.room && id !== mine?.id) : undefined;
  const swapped = peeked !== undefined && (phone || !wide);
  const talkShown = phone ? route.at === "talk" : !swapped;
  const count = unread(snapshot);
  const online = snapshot.line.kind === "open";

  useEffect(() => {
    document.title = house.name;
  }, [house.name]);
  useEffect(() => {
    if (route.at === "peek" && peeked === undefined) go(route.room === mine?.id ? { at: "talk" } : { at: "plan" }, true);
  }, [route, peeked, mine?.id, go]);
  useEffect(() => session.peek(peeked?.id), [session, peeked?.id]);
  // A tab in the background has shown nothing.
  const newest = (mine === undefined ? undefined : snapshot.logs.get(mine.id))?.events.at(-1)?.id;
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
  const open = (target: FocusTarget) => {
    opener.current = document.activeElement;
    wanted.current = target;
  };

  const peek = (room: string) => {
    if (peeked === undefined) open("peek");
    else wanted.current = "peek";
    go({ at: "peek", room });
  };
  const toPlan = () => {
    wanted.current = "opener";
    go({ at: "plan" });
  };
  const openTalk = () => {
    if (phone) open("room");
    else wanted.current = "field";
    go({ at: "talk" });
  };
  const enter = async (room: string) => {
    if (!(await session.enter(room))) return;
    // Focusing the field on a phone would raise the keyboard over the room just entered.
    wanted.current = phone ? "room" : "field";
    go({ at: "talk" }, route.at === "peek");
  };
  const leave = async () => {
    await session.leave();
    wanted.current = phone ? "plan" : "room";
    if (phone) go({ at: "plan" });
  };
  const older = useCallback((room: string) => session.older(room), [session]);

  const residents = residentsOf(house);
  const shared = { you: house.you, residents, undelivered: snapshot.undelivered, phone, line: snapshot.line, onRetry: () => session.retry() };
  const notice = snapshot.notice;
  const nameOf = (room: string) => house.rooms.find(({ id }) => id === room)?.name ?? room;
  const notices = (
    <div className="house-notices" role="status" aria-live="polite">
      {notice ? (
        <Banner
          status={notice.kind === "failed" ? "error" : "warning"}
          title={notice.kind === "failed" ? words.failed : notice.kind === "full" ? words.enterFull(nameOf(notice.room)) : words.returnFailed(nameOf(notice.room))}
          elevation="med"
          isDismissable
          dismissLabel={words.dismiss}
          onDismiss={() => session.dismiss()}
        />
      ) : null}
    </div>
  );
  const plan = (
    <Plan
      house={house}
      mine={mine?.id}
      peek={peeked?.id}
      online={online}
      phone={phone}
      unread={count}
      lineNotice={<LineNotice line={snapshot.line} onRetry={() => session.retry()} />}
      heading={planHeading}
      onPeek={peek}
      onEnter={(room) => void enter(room)}
      onOpenTalk={openTalk}
      onLogout={() => void session.logout()}
    />
  );
  const myRoomPane = (
    <MyRoom
      {...shared}
      narrow={phone || peeked !== undefined}
      room={mine}
      log={mine === undefined ? undefined : snapshot.logs.get(mine.id)}
      touch={touch}
      draft={draft}
      onDraft={setDraft}
      onSay={(text, to) => session.say(text, to)}
      onOlder={() => (mine === undefined ? Promise.resolve() : older(mine.id))}
      onLeave={() => void leave()}
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
        onEnter={() => void enter(peeked.id)}
        onClose={toPlan}
        onBackToMine={openTalk}
        heading={peekHeading}
      />
    );

  if (phone) {
    const covered = route.at === "talk" || peeked !== undefined;
    return (
      <main ref={root} className="house house-phone">
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
      <a
        className="skip-link"
        href="#conversation"
        onClick={(event) => {
          event.preventDefault();
          roomHeading.current?.focus();
        }}
      >
        {words.skip}
      </a>
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
