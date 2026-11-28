import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useRef } from "react";

import type { HouseDirectAvailability } from "@penelope/contract";

import { BackIcon } from "./icons.tsx";
import { ResidentAvatar, type Shown } from "./residents.tsx";
import { type ConversationPane, ConversationRecord, LineNotice } from "./Room.tsx";
import { Speak, type SpeakProps } from "./Speak.tsx";
import { words } from "./words.ts";

type DirectProps = ConversationPane & Pick<SpeakProps, "touch" | "writing" | "onWriting" | "onSay"> & {
  onBack: () => void;
  resident: Shown | undefined;
  availability: HouseDirectAvailability | undefined;
};

export function Direct({ resident, availability, log, heading, phone, line, onRetry, touch, writing, onWriting, onSay, onBack, ...timeline }: DirectProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const available = resident !== undefined && availability !== undefined && log?.sync?.phase !== "unavailable";
  const label = available ? words.directLog(resident.name) : words.direct;
  const note = availability?.send === "in-room" ? words.directInRoom
    : availability?.send === "deployment-unsupported" ? words.directUnsupported
    : availability?.sleeping ? words.directSleep
    : availability?.connected === false ? words.directWaiting : undefined;

  return (
    <section className="room" id="conversation" aria-labelledby="direct-heading">
      <header className="room-head">
        {phone ? <IconButton icon={<Icon icon={BackIcon} />} label={words.backToPlan} variant="ghost" size="lg" onClick={onBack} /> : null}
        {available ? <ResidentAvatar resident={resident} size={36} plain /> : null}
        <div className="room-title">
          <h2 id="direct-heading" ref={heading} tabIndex={-1}>{label}</h2>
        </div>
        {phone ? null : <IconButton icon={<Icon icon="close" />} label={words.backToPlan} variant="ghost" onClick={onBack} />}
      </header>
      {available ? (
        <ConversationRecord
          {...timeline}
          label={label}
          empty={words.directEmpty}
          log={log}
          scroller={scroller}
          bottom={
            <>
              <LineNotice line={line} onRetry={onRetry} />
              <div className="room-entry-status" role="status">{note ? <p className="direct-note">{note}</p> : null}</div>
              <Speak target={{ kind: "dm", name: resident.name }} online={line.kind === "open" && availability.send === "ready"} touch={touch} writing={writing} onWriting={onWriting} onSay={onSay} />
            </>
          }
        />
      ) : <p className="room-nowhere" role="status">{words.directUnavailable}</p>}
    </section>
  );
}
