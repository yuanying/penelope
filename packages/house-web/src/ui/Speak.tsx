// Whom a speech is addressed to is a field of its own, chosen from the
// residents of the room: a name written in the text addresses no one
// (ADR-0075, 7). A speech that got no answer may be recorded
// (docs/house.md, 話す): it is kept apart from what is written next and is
// sent again only when the person says so.
import { Button } from "@astryxdesign/core/Button";
import { type ChatComposerTrigger, ChatComposer, ChatComposerInput, ChatSendButton } from "@astryxdesign/core/Chat";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { type KeyboardEvent, useMemo } from "react";

import type { HousePersonOccupant } from "@penelope/contract";

import type { Said } from "../model/session.ts";
import { isAsleep, ResidentAvatar } from "./residents.tsx";
import { words } from "./words.ts";

export type Draft = { text: string; to: readonly string[] };
/** A speech the house did not take (`refused`) or did not answer (`unknown`). */
export type Unsent = Draft & { said: Exclude<Said, "sent"> };
/** What is written for one room. It stays that room's when the person moves. */
export type Writing = { draft: Draft; unsent: readonly Unsent[] };

const EMPTY_DRAFT: Draft = { text: "", to: [] };
export const NOTHING_WRITTEN: Writing = { draft: EMPTY_DRAFT, unsent: [] };

export type SpeakProps = {
  room: { id: string; name: string };
  others: readonly HousePersonOccupant[];
  online: boolean;
  /** A touch screen has no Shift to hold: Enter is a new line there, and the button sends. */
  touch: boolean;
  writing: Writing;
  /** Changes what is written for `room`, also after the person left it. */
  onWriting: (change: (writing: Writing) => Writing) => void;
  /** Says it in `room`. */
  onSay: (text: string, to: readonly string[]) => Promise<Said>;
};

/** Hiragana as katakana, in lower case: a name is found whichever way it is typed. */
const folded = (text: string) => text.replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60)).toLowerCase();

export function Speak({ room, others, online, touch, writing, onWriting, onSay }: SpeakProps) {
  const { draft, unsent } = writing;
  const present = (ids: readonly string[]) => others.filter(({ id }) => ids.includes(id));
  const to = present(draft.to);
  const candidates = others.filter(({ id }) => !draft.to.includes(id));
  const canSend = online && draft.text.trim() !== "";

  const onDraft = (change: (draft: Draft) => Draft) => onWriting((now) => ({ ...now, draft: change(now.draft) }));
  const address = (id: string) => onDraft((now) => (now.to.includes(id) ? now : { ...now, to: [...now.to, id] }));
  const say = async (text: string, addressed: readonly string[]) => {
    const said = await onSay(text, addressed);
    if (said !== "sent") onWriting((now) => ({ ...now, unsent: [...now.unsent, { text, to: addressed, said }] }));
  };
  const send = (written: string) => {
    const text = written.trim();
    if (!online || text === "") return;
    onDraft(() => EMPTY_DRAFT);
    void say(text, to.map(({ id }) => id));
  };
  const without = (speech: Unsent) => onWriting((now) => ({ ...now, unsent: now.unsent.filter((each) => each !== speech) }));

  // The residents' state is in the key: a candidate says whether it sleeps now.
  const candidateKey = candidates.map((resident) => `${resident.id}:${isAsleep(resident)}`).join(" ");
  const triggers = useMemo(() => {
    const items = candidates.map((resident) => ({ id: resident.id, label: resident.name, auxiliaryData: resident }));
    const trigger = (character: string): ChatComposerTrigger => ({
      character,
      searchSource: {
        bootstrap: () => items,
        search: (query) => items.filter(({ id, label }) => folded(label).includes(folded(query)) || id.startsWith(query.toLowerCase())),
      },
      renderItem: (item) => <Candidate resident={item.auxiliaryData as HousePersonOccupant} />,
      // Astryx puts what this returns in the place of the `@` and what was typed after it.
      onSelect: (item) => {
        address(item.id);
        return "";
      },
      emptySearchText: others.length > 0 ? words.noCandidates : words.nobodyElse,
      menuLabel: words.pickToLabel,
    });
    return [trigger("@"), trigger("＠")];
    // `address` changes what is written through `onWriting`, which is the same for a room.
  }, [candidateKey, others.length, onWriting]);

  return (
    <>
      {unsent.map((speech, index) => {
        const addressed = present(speech.to);
        return (
          <div key={index} className="speak-unsent" role="group" aria-label={speech.said === "unknown" ? words.unsentUnknown : words.unsentRefused}>
            <p className="speak-unsent-why">
              <b>{speech.said === "unknown" ? words.unsentUnknown : words.unsentRefused}</b>
              {speech.said === "unknown" ? ` ${words.unsentUnknownHint}` : null}
            </p>
            <p className="speak-unsent-text">
              {addressed.map((resident) => (
                <span key={resident.id} className="speech-to" translate="no">
                  @{resident.name}{" "}
                </span>
              ))}
              {speech.text}
            </p>
            <div className="speak-unsent-actions">
              <Button
                label={words.resend}
                variant="secondary"
                size={touch ? "lg" : "sm"}
                isDisabled={!online}
                onClick={() => {
                  without(speech);
                  void say(speech.text, addressed.map(({ id }) => id));
                }}
              />
              <Button
                label={words.backToField}
                variant="secondary"
                size={touch ? "lg" : "sm"}
                isDisabled={draft.text !== "" || draft.to.length > 0}
                onClick={() => onWriting((now) => ({ draft: { text: speech.text, to: speech.to }, unsent: now.unsent.filter((each) => each !== speech) }))}
              />
              <Button label={words.discard} variant="ghost" size={touch ? "lg" : "sm"} onClick={() => without(speech)} />
            </div>
          </div>
        );
      })}
      <ChatComposer
        value={draft.text}
        onChange={(text) => onDraft((now) => ({ ...now, text }))}
        onSubmit={send}
        isDisabled={!online}
        density="spacious"
        {...(to.length > 0
          ? {
              headerActions: (
                <div className="speak-to" role="group" aria-label={words.to}>
                  <span className="speak-to-label" aria-hidden>
                    {words.to}
                  </span>
                  {to.map((resident) => (
                    <span key={resident.id} className="speak-to-chip">
                      <span translate="no">
                        @{resident.name}
                        {isAsleep(resident) ? words.asleepMark : ""}
                      </span>
                      <button type="button" aria-label={words.removeTo(resident.name)} onClick={() => onDraft((now) => ({ ...now, to: now.to.filter((id) => id !== resident.id) }))}>
                        <Icon icon="close" size="xsm" color="inherit" />
                      </button>
                    </span>
                  ))}
                </div>
              ),
            }
          : {})}
        input={
          <ChatComposerInput
            label={words.speakIn(room.name)}
            placeholder={words.speakPlaceholder(room.name)}
            triggers={triggers}
            hasHistory={false}
            pasteAsToken={false}
            debounceMs={0}
            {...(touch ? { enterKeyHint: "enter" as const, onKeyDown: breakLine } : {})}
          />
        }
        footerActions={
          <>
            <DropdownMenu
              button={{ label: words.pickTo, variant: "secondary", size: "md", isDisabled: !online }}
              hasChevron={false}
              header={<span className="speak-pick-head">{words.pickToLabel}</span>}
              items={
                candidates.length > 0
                  ? candidates.map((resident) => ({
                      id: resident.id,
                      label: resident.name,
                      icon: <ResidentAvatar resident={resident} size={24} />,
                      ...(isAsleep(resident) ? { description: words.asleepNoReach } : {}),
                      onClick: () => address(resident.id),
                    }))
                  : [{ id: "none", label: others.length > 0 ? words.noCandidates : words.nobodyElse, isDisabled: true }]
              }
            />
            {touch ? null : <span className="speak-hint">{words.enterHint}</span>}
          </>
        }
        sendButton={<ChatSendButton isDisabled={!canSend} onSend={() => send(draft.text)} />}
      />
    </>
  );
}

/**
 * Enter on a touch keyboard. Astryx would send on it, and stopping that also
 * stops the browser's own line break, so the break is made here. Astryx has
 * already given the key to an open menu of candidates, and an Enter that
 * confirms a composition is left to the keyboard.
 */
function breakLine(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  document.execCommand("insertLineBreak");
}

function Candidate({ resident }: { resident: HousePersonOccupant }) {
  return (
    <span className="speak-candidate">
      <ResidentAvatar resident={resident} size={24} />
      <span className="speak-candidate-name" translate="no">
        {resident.name}
      </span>
      {isAsleep(resident) ? <span className="speak-candidate-asleep">{words.asleepNoReach}</span> : null}
    </span>
  );
}
