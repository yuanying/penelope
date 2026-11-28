import { Badge } from "@astryxdesign/core/Badge";
import { SideNavItem } from "@astryxdesign/core/SideNav";
import type { ComponentType, SVGProps } from "react";

import { EventsIcon, LogIcon, MemoryIcon, SettingsIcon, SubAgentIcon } from "./icons.tsx";
import type { Place } from "./route.ts";
import { words } from "./words.ts";

const PLACES: Array<[Place, ComponentType<SVGProps<SVGSVGElement>>]> = [
  ["memory", MemoryIcon],
  ["log", LogIcon],
  ["status", SubAgentIcon],
  ["events", EventsIcon],
  ["settings", SettingsIcon],
];

export function PlaceItems({
  place,
  onChange,
  unseen = 0,
}: {
  place: Place;
  onChange: (place: Place) => void;
  /** The failures of the activity record not seen: its count beside it, or on its icon while the rail is folded. */
  unseen?: number;
}) {
  return (
    <>
      {PLACES.map(([name, icon]) => {
        const counted = name === "log" && unseen > 0;
        return (
          <SideNavItem
            key={name}
            label={words.places[name]}
            icon={icon}
            isSelected={place === name}
            onClick={() => onChange(name)}
            {...(counted
              ? {
                  "aria-label": words.record.railLabel(unseen),
                  endContent: <Badge variant="error" label={String(unseen)} />,
                }
              : {})}
          />
        );
      })}
    </>
  );
}
