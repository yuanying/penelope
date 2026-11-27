import { Button } from "@astryxdesign/core/Button";
import { ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Fragment, type RefObject, useLayoutEffect, useRef, useState } from "react";

import type { HouseActor, HouseEvent, HousePersonView } from "@penelope/contract";

import type { RoomLog } from "../model/log.ts";
import { EnterIcon, LeaveIcon, MoonIcon } from "./icons.tsx";
import { keyOf, ResidentAvatar, type Shown, speakerOf } from "./residents.tsx";
import { dayOf, timeOf, words } from "./words.ts";

type Speech = Extract<HouseEvent, { kind: "speech" }>;


export type TimelineProps = {
  log: RoomLog;
  you: HousePersonView["you"];
  residents: ReadonlyMap<string, Shown>;
  undelivered: ReadonlyMap<string, readonly HouseActor[]>;
  /** In a narrow column the speaker's picture stands small beside the name, not beside the text. */
  narrow: boolean;
  scroller: RefObject<HTMLElement | null>;
  onOlder: () => Promise<void>;
};

export function Timeline({ log, you, residents, undelivered, narrow, scroller, onOlder }: TimelineProps) {
  const [reading, setReading] = useState(false);
  // An older page is put before what is on the screen: the distance from the end is what stays the same.
  const fromEnd = useRef<number | undefined>(undefined);
  const { events } = log;
  const oldest = events[0]?.id;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && fromEnd.current !== undefined) element.scrollTop = element.scrollHeight - fromEnd.current;
    fromEnd.current = undefined;
  }, [oldest, scroller]);

  const older = async () => {
    setReading(true);
    const element = scroller.current;
    if (element) fromEnd.current = element.scrollHeight - element.scrollTop;
    try {
      await onOlder();
    } finally {
      setReading(false);
    }
  };

  let lastDay: string | undefined;
  let lastSpeaker: string | undefined;
  return (
    <ChatMessageList density={narrow ? "compact" : "spacious"} gap={4}>
      {log.before !== undefined ? (
        <div className="timeline-older">
          <Button label={words.older} variant="secondary" size="sm" isLoading={reading} onClick={() => void older()} />
        </div>
      ) : null}
      {events.map((event) => {
        // Only the rows of older pages are laid out late (`content-visibility`). Astryx follows the end of the
        // record by its height, and gives the end up when rows change their height while it follows: a row that
        // was there when the record was opened, or came since, never does.
        const far = log.pagedBelow !== undefined && event.seq < log.pagedBelow;
        const day = dayOf(event.occurred_at);
        const divider = day !== lastDay ? <ChatSystemMessage variant="divider">{day}</ChatSystemMessage> : null;
        if (divider) lastSpeaker = undefined;
        lastDay = day;
        const speaker = event.kind === "speech" ? keyOf(event.actor) : undefined;
        const continued = speaker !== undefined && speaker === lastSpeaker;
        lastSpeaker = speaker;
        return (
          <Fragment key={event.id}>
            {divider}
            {event.kind !== "speech" ? (
              <Move event={event} far={far} />
            ) : event.actor.kind === "person" && event.actor.id === you.id ? (
              <Mine event={event} you={you} residents={residents} undelivered={undelivered.get(event.id)} far={far} />
            ) : (
              <Theirs event={event} you={you} residents={residents} narrow={narrow} continued={continued} far={far} />
            )}
          </Fragment>
        );
      })}
    </ChatMessageList>
  );
}

function Move({ event, far }: { event: HouseEvent; far: boolean }) {
  const came = event.kind === "enter";
  return (
    <ChatSystemMessage {...(far ? { className: "timeline-far" } : {})} icon={<Icon icon={came ? EnterIcon : LeaveIcon} size="xsm" color="inherit" />}>
      <span className="timeline-move" data-event={event.kind}>
        {(came ? words.came : words.left)(event.actor.name, event.room.name)}
        <time dateTime={event.occurred_at}>{timeOf(event.occurred_at)}</time>
      </span>
    </ChatSystemMessage>
  );
}

function Words({ event, you, residents }: { event: Speech; you: HousePersonView["you"]; residents: ReadonlyMap<string, Shown> }) {
  const known = [...residents.values()];
  return (
    <span className="speech-text">
      {event.to.map((id) => (
        <Fragment key={id}>
          <span className={id === you.id ? "speech-to speech-to-you" : "speech-to"} translate="no">
            @{known.find((resident) => resident.id === id)?.name ?? id}
          </span>{" "}
        </Fragment>
      ))}
      {event.text}
    </span>
  );
}

function Theirs({ event, you, residents, narrow, continued, far }: { event: Speech; you: HousePersonView["you"]; residents: ReadonlyMap<string, Shown>; narrow: boolean; continued: boolean; far: boolean }) {
  const speaker = speakerOf(residents, event.actor);
  const name = continued ? undefined : (
    <span className="speech-who">
      {narrow ? <ResidentAvatar resident={speaker} size={24} plain /> : null}
      <span className="speech-name" translate="no">
        {event.actor.name}
      </span>
      <time dateTime={event.occurred_at}>{timeOf(event.occurred_at)}</time>
    </span>
  );
  const avatar = narrow ? undefined : (
    <span className="speech-avatar">{continued ? null : <ResidentAvatar resident={speaker} size={36} plain />}</span>
  );
  return (
    <ChatMessage sender="assistant" {...(avatar ? { avatar } : {})} className={[continued ? "speech-continued" : "", far ? "timeline-far" : ""].join(" ").trim()}>
      <ChatMessageBubble variant="ghost" className="speech-plain" {...(name ? { name } : {})} data-speech={event.id}>
        <Words event={event} you={you} residents={residents} />
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function Mine({ event, you, residents, undelivered, far }: { event: Speech; you: HousePersonView["you"]; residents: ReadonlyMap<string, Shown>; undelivered: readonly HouseActor[] | undefined; far: boolean }) {
  const metadata = (
    <span className="speech-meta">
      <time dateTime={event.occurred_at}>{timeOf(event.occurred_at)}</time>
      {undelivered ? (
        <span className="speech-undelivered">
          <Icon icon={MoonIcon} size="xsm" color="inherit" />
          <span>{words.undelivered(undelivered)}</span>
        </span>
      ) : null}
    </span>
  );
  return (
    <ChatMessage sender="user" {...(far ? { className: "timeline-far" } : {})}>
      <ChatMessageBubble variant="filled" data-speech={event.id} metadata={metadata}>
        <Words event={event} you={you} residents={residents} />
      </ChatMessageBubble>
    </ChatMessage>
  );
}
