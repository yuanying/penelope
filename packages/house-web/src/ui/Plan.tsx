// A room is looked into with one button and entered with another: to enter
// starts the turns of the awake residents (ADR-0075, 4), so it is never what
// a slip of the finger does.
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import type { ReactNode, RefObject } from "react";

import type { HousePersonView } from "@penelope/contract";

import { EyeIcon, ForwardIcon } from "./icons.tsx";
import { AwayResident, keyOf, ResidentAvatar, ResidentCard, ResidentStack } from "./residents.tsx";
import { timeOf, withUnread, words } from "./words.ts";

type Room = HousePersonView["rooms"][number];

export type PlanProps = {
  house: HousePersonView;
  mine: string | undefined;
  peek: string | undefined;
  online: boolean;
  /** On a phone the conversation is a screen of its own, opened from the person's room or from the strip below. */
  phone: boolean;
  openTalkFromTile: boolean;
  unread: number;
  lineNotice?: ReactNode;
  heading: RefObject<HTMLHeadingElement | null>;
  /** The way to the conversation on a phone. */
  dock: RefObject<HTMLButtonElement | null>;
  onPeek: (room: string) => void;
  onEnter: (room: string) => void;
  onOpenTalk: () => void;
  onLogout: () => void;
};

const isFull = (room: Room) => room.capacity !== null && room.occupants.length >= room.capacity;

function Capacity({ room }: { room: Room }) {
  const count = room.occupants.length;
  if (room.capacity === null) return <span className="plan-count">{count > 0 ? words.people(count) : words.nobody}</span>;
  return isFull(room) ? (
    <span className="plan-count plan-count-full">{words.full(count, room.capacity)}</span>
  ) : (
    <span className="plan-count">{words.seats(count, room.capacity)}</span>
  );
}

export function Plan({ house, mine, peek, online, phone, openTalkFromTile, unread, lineNotice, heading, dock, onPeek, onEnter, onOpenTalk, onLogout }: PlanProps) {
  const myRoom = house.rooms.find(({ id }) => id === mine);
  return (
    <div className="plan">
      <div className="plan-scroll">
        <header className="plan-head">
          <div>
            <h1 ref={heading} tabIndex={-1} translate="no">
              {house.name}
            </h1>
            <p className="plan-sub">{words.plan}</p>
          </div>
          <DropdownMenu
            renderTrigger={(trigger) => (
              <button {...trigger} type="button" className="plan-me" aria-label={words.account(house.you.name)}>
                <ResidentAvatar resident={house.you} size={32} />
              </button>
            )}
            alignment="end"
            items={[{ id: "logout", label: words.logout, onClick: onLogout }]}
          />
        </header>
        <div className="plan-tiles">
          {house.rooms.map((room) => {
            const here = room.id === mine;
            const peeked = room.id === peek;
            return (
              <article key={room.id} className={here ? "tile tile-here" : peeked ? "tile tile-peeked" : "tile"} aria-labelledby={`room-${room.id}`} data-room={room.id}>
                <header className="tile-head">
                  <h2 id={`room-${room.id}`}>{room.name}</h2>
                  <Capacity room={room} />
                </header>
                <p className="tile-about">{room.description}</p>
                {room.occupants.length > 0 ? (
                  <ul className="residents" role="list">
                    {room.occupants.map((resident) => (
                      <ResidentCard key={keyOf(resident)} resident={resident} self={resident.kind === "person" && resident.id === house.you.id} />
                    ))}
                  </ul>
                ) : null}
                {room.last_speech ? (
                  <p className="tile-last">
                    <b translate="no">{room.last_speech.actor.name}</b> {room.last_speech.text}{" "}
                    <time dateTime={room.last_speech.occurred_at}>{timeOf(room.last_speech.occurred_at)}</time>
                  </p>
                ) : null}
                <footer className="tile-foot">
                  {here ? (
                    <>
                      <span className="tile-tag tile-tag-here">{words.here}</span>
                      {openTalkFromTile ? <Button label={words.openTalk} variant="secondary" size={phone ? "lg" : "sm"} onClick={onOpenTalk} /> : null}
                    </>
                  ) : (
                    <>
                      <Button
                        label={words.peek}
                        aria-label={words.peekRoom(room.name)}
                        aria-pressed={peeked}
                        icon={<Icon icon={EyeIcon} size="sm" color="inherit" />}
                        variant="secondary"
                        size={phone ? "lg" : "sm"}
                        onClick={() => onPeek(room.id)}
                      />
                      {isFull(room) ? (
                        <span className="tile-tag">{words.fullNoEntry}</span>
                      ) : (
                        <Button
                          label={words.enter}
                          aria-label={words.enterRoom(room.name)}
                          variant="secondary"
                          size={phone ? "lg" : "sm"}
                          isDisabled={!online}
                          onClick={() => onEnter(room.id)}
                        />
                      )}
                      {peeked ? <span className="tile-tag">{words.peeking}</span> : null}
                    </>
                  )}
                </footer>
              </article>
            );
          })}
          <article className="tile tile-away" aria-labelledby="room-away">
            <header className="tile-head">
              <h2 id="room-away">{words.away}</h2>
            </header>
            {house.away.length > 0 ? (
              <ul className="residents" role="list">
                {house.away.map((resident) => (
                  <AwayResident key={keyOf(resident)} resident={resident} self={resident.kind === "person" && resident.id === house.you.id} />
                ))}
              </ul>
            ) : (
              <p className="tile-about">{words.allHome}</p>
            )}
          </article>
        </div>
      </div>
      {phone ? (
        <div className="plan-dock-stack">
          {lineNotice}
          {myRoom === undefined ? (
            <p className="plan-dock plan-dock-off">{words.nowhereDock}</p>
          ) : (
            <button ref={dock} type="button" className="plan-dock" aria-label={withUnread(words.openTalkOf(myRoom.name), unread)} onClick={onOpenTalk}>
              <ResidentStack residents={myRoom.occupants} size={32} max={3} />
              <span className="plan-dock-words">
                <b>{words.inRoom(myRoom.name)}</b>
                <span className="plan-dock-last">
                  {myRoom.last_speech ? (
                    <>
                      <span translate="no">{myRoom.last_speech.actor.name}</span> {myRoom.last_speech.text}
                    </>
                  ) : (
                    words.silent
                  )}
                </span>
              </span>
              {unread > 0 ? (
                <span className="unread" aria-hidden>
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null}
              <ForwardIcon width={18} height={18} />
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
