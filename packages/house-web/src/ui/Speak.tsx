// Whom a speech is addressed to is a field of its own, chosen from the
// residents of the room: a name written in the text addresses no one
// (ADR-0075, 7).
import { type ChatComposerTrigger, ChatComposer, ChatComposerInput, ChatSendButton } from "@astryxdesign/core/Chat";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { type KeyboardEvent, useMemo, useState } from "react";

import type { HousePersonOccupant } from "@penelope/contract";

import type { Said } from "../model/session.ts";
import { isAsleep, ResidentAvatar } from "./residents.tsx";
import { words } from "./words.ts";

export type Draft = { text: string; to: readonly string[] };
export const EMPTY_DRAFT: Draft = { text: "", to: [] };

export type SpeakProps = {
  room: { id: string; name: string };
  others: readonly HousePersonOccupant[];
  online: boolean;
  /** A touch screen has no Shift to hold: Enter is a new line there, and the button sends. */
  touch: boolean;
  draft: Draft;
  onDraft: (change: (draft: Draft) => Draft) => void;
  onSay: (text: string, to: readonly string[]) => Promise<Said>;
};

/** Hiragana as katakana, in lower case: a name is found whichever way it is typed. */
const folded = (text: string) => text.replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60)).toLowerCase();

export function Speak({ room, others, online, touch, draft, onDraft, onSay }: SpeakProps) {
  const [failure, setFailure] = useState<"refused" | "unknown">();
  const to = others.filter(({ id }) => draft.to.includes(id));
  const candidates = others.filter(({ id }) => !draft.to.includes(id));
  const canSend = online && draft.text.trim() !== "";

  const address = (id: string) => onDraft((now) => (now.to.includes(id) ? now : { ...now, to: [...now.to, id] }));
  const send = async (written: string) => {
    const text = written.trim();
    if (!online || text === "") return;
    const addressed = to.map(({ id }) => id);
    setFailure(undefined);
    onDraft(() => EMPTY_DRAFT);
    const said = await onSay(text, addressed);
    if (said === "sent") return;
    // Not said, or not known to be: it goes back into the field, before what was written since.
    onDraft((now) => ({ text: now.text === "" ? text : `${text}\n${now.text}`, to: [...new Set([...addressed, ...now.to])] }));
    if (said !== "offline") setFailure(said);
  };

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
  }, [candidates.map(({ id }) => id).join(" "), others.length, onDraft]);

  return (
    <ChatComposer
      value={draft.text}
      onChange={(text) => onDraft((now) => ({ ...now, text }))}
      onSubmit={(written) => void send(written)}
      isDisabled={!online}
      density="spacious"
      {...(failure ? { status: { type: "error" as const, message: failure === "refused" ? words.sayRefused : words.sayUnknown } } : {})}
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
          {...(touch
            ? {
                enterKeyHint: "enter" as const,
                onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === "Enter") event.preventDefault();
                },
              }
            : {})}
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
      sendButton={<ChatSendButton isDisabled={!canSend} onSend={() => void send(draft.text)} />}
    />
  );
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
