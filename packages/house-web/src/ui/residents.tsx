import { Avatar } from "@astryxdesign/core/Avatar";
import { Icon } from "@astryxdesign/core/Icon";
import type { MouseEvent } from "react";

import type { HouseActor, HouseExpression, HousePersonOccupant, HousePersonView, HousePublicIdentity } from "@penelope/contract";

import { ExternalIcon, MoonIcon, WarningIcon } from "./icons.tsx";
import { hashOf } from "./route.ts";
import { UnreadBadge } from "./UnreadBadge.tsx";
import { timeOf, withUnread, words } from "./words.ts";

export type Shown = HousePersonOccupant | HousePublicIdentity;

export function residentsOf(house: HousePersonView): ReadonlyMap<string, Shown> {
  const all: Shown[] = [...house.rooms.flatMap(({ occupants }) => occupants), ...house.away];
  return new Map(all.map((resident) => [keyOf(resident), resident]));
}

/** One who spoke may no longer be a resident: the record still gives the name. */
export function speakerOf(residents: ReadonlyMap<string, Shown>, actor: HouseActor): Shown {
  return residents.get(keyOf(actor)) ?? (actor.kind === "agent" ? { ...actor, kind: "agent" } : { ...actor, kind: "person" });
}

export const keyOf = ({ kind, id }: Pick<HouseActor, "kind" | "id">) => `${kind}:${id}`;

function statusOf(resident: Shown) {
  return resident.kind === "agent" && "status" in resident ? resident.status : undefined;
}

/** Falling asleep and asleep are one to the screen: what is said reaches neither (ADR-0075, 5). */
export function isAsleep(resident: Shown): boolean {
  const status = statusOf(resident);
  return status != null && status.sleep.state !== "awake";
}

function isDown(resident: Shown): boolean {
  return resident.kind === "agent" && "connected" in resident && !resident.connected;
}

export type AvatarSize = 24 | 32 | 36 | 40;

/**
 * `plain` draws the picture as it is, for the conversation. Elsewhere a
 * sleeper has a moon over the same picture and one the house does not hear
 * from is faded. `named` is for where no name stands beside the picture.
 */
export function avatarOf(resident: Shown, expression: HouseExpression = "neutral"): string | undefined {
  return (resident.kind === "agent" ? resident.avatar_urls?.[expression] ?? resident.avatar_urls?.neutral : undefined) ?? resident.avatar_url;
}

export function ResidentAvatar({ resident, size, expression, plain = false, named = false }: { resident: Shown; size: AvatarSize; expression?: HouseExpression | undefined; plain?: boolean; named?: boolean }) {
  const asleep = !plain && isAsleep(resident);
  const src = avatarOf(resident, expression);
  return (
    <span className={!plain && isDown(resident) ? "resident-avatar resident-avatar-down" : "resident-avatar"}>
      <Avatar
        {...(src === undefined ? {} : { src })}
        name={resident.name}
        alt={named ? `${resident.name}${asleep ? words.asleepMark : ""}` : ""}
        size={size}
        shape="rounded"
        tooltip={false}
      />
      {asleep ? (
        <span className="resident-moon" aria-hidden>
          <MoonIcon width={Math.max(10, Math.round(size * 0.3))} height={Math.max(10, Math.round(size * 0.3))} />
        </span>
      ) : null}
    </span>
  );
}

function personalPage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.href.includes("#") ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type DirectOpener = (event: MouseEvent<HTMLAnchorElement>, agent: string) => void;

type DirectLinkProps = { onDirect?: DirectOpener | undefined; directUnread?: number | undefined };

function ResidentLinks({ resident, onDirect, directUnread = 0 }: { resident: Shown } & DirectLinkProps) {
  if (resident.kind !== "agent") return null;
  const personal = personalPage(resident.personal_url);
  if (!personal && !onDirect) return null;
  return (
    <div className="resident-links">
      {onDirect ? (
        <a className="resident-link" href={hashOf({ at: "dm", agent: resident.id })} aria-label={withUnread(words.directWith(resident.name), directUnread)} onClick={(event) => onDirect(event, resident.id)}>
          {words.direct}
          <UnreadBadge count={directUnread} />
        </a>
      ) : null}
      {personal ? (
        <a className="resident-link" href={personal} target="_blank" rel="noreferrer" aria-label={words.personalOf(resident.name)}>
          {words.personal}
          <ExternalIcon width={12} height={12} aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

function StateLine({ resident, self }: { resident: HousePersonOccupant; self: boolean }) {
  if (!resident.connected) {
    return (
      <div className="resident-state resident-state-down">
        <Icon icon={WarningIcon} size="xsm" color="inherit" />
        {words.disconnected}
      </div>
    );
  }
  const status = statusOf(resident);
  if (status != null && status.sleep.state !== "awake") {
    return (
      <div className="resident-state resident-state-asleep">
        <Icon icon={MoonIcon} size="xsm" color="inherit" />
        {words.asleepUntil(timeOf(status.sleep.wake_at))}
      </div>
    );
  }
  return (
    <div className="resident-state">
      <span className="resident-dot" aria-hidden />
      {resident.kind === "agent" ? words.awake : self ? words.thisScreen : words.screenOpen}
    </div>
  );
}

export function ResidentCard({ resident, self, ...direct }: { resident: HousePersonOccupant; self: boolean } & DirectLinkProps) {
  const status = statusOf(resident);
  return (
    <li className="resident">
      <ResidentAvatar resident={resident} size={40} />
      <div className="resident-body">
        <div className="resident-name">
          <span className="resident-name-text" translate="no">
            {resident.name}
          </span>
          {self ? <span className="resident-self">{words.self}</span> : null}
        </div>
        <StateLine resident={resident} self={self} />
        {status?.mood ? <div className="resident-mood">「{status.mood}」</div> : null}
        {status ? (
          <div className="resident-sleepiness" role="img" aria-label={words.sleepinessOf(Math.round(status.sleepiness))}>
            <span>{words.sleepiness}</span>
            <span className="resident-bar">
              <span style={{ width: `${Math.min(100, Math.max(0, status.sleepiness))}%` }} />
            </span>
            <span className="resident-number">{Math.round(status.sleepiness)}</span>
          </div>
        ) : null}
        <ResidentLinks resident={resident} {...direct} />
      </div>
    </li>
  );
}

export function AwayResident({ resident, self, ...direct }: { resident: HousePublicIdentity; self: boolean } & DirectLinkProps) {
  return (
    <li className="resident resident-away">
      <ResidentAvatar resident={resident} size={40} />
      <div className="resident-body">
        <div className="resident-name">
          <span className="resident-name-text" translate="no">
            {resident.name}
          </span>
          {self ? <span className="resident-self">{words.self}</span> : null}
        </div>
        <ResidentLinks resident={resident} {...direct} />
      </div>
    </li>
  );
}

export function ResidentStack({ residents, size, max }: { residents: readonly HousePersonOccupant[]; size: AvatarSize; max?: number }) {
  return (
    <span className="resident-stack">
      {residents.slice(0, max).map((resident) => (
        <ResidentAvatar key={keyOf(resident)} resident={resident} size={size} named />
      ))}
    </span>
  );
}
