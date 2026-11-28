// The line icons of the design (docs/design/), as Astryx takes them: an SVG
// component its parent sizes and colors.
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true } as const;

export const LogIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const MemoryIcon = (props: Props) => (
  <svg {...base} strokeLinejoin="round" {...props}>
    <path d="M5 4h11l3 3v13H5V4z" />
    <path d="M9 10h6M9 14h6" strokeLinecap="round" />
  </svg>
);
export const EventsIcon = (props: Props) => (
  <svg {...base} strokeLinejoin="round" {...props}>
    <path d="M4 13l3-8h10l3 8v6H4v-6z" />
    <path d="M4 13h5l1 2h4l1-2h5" />
  </svg>
);
export const RepeatIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M17 3l4 4-4 4" />
    <path d="M3 11V9a2 2 0 0 1 2-2h16" />
    <path d="M7 21l-4-4 4-4" />
    <path d="M21 13v2a2 2 0 0 1-2 2H3" />
  </svg>
);
export const SettingsIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" {...props}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
);
export const MenuIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

// The marks of the activity record (docs/design/README.md, 15). Each says
// what it marks by its shape, not by its color alone; the words go beside it.
export const CheckIcon = (props: Props) => (
  <svg {...base} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
/** Failed: a filled circle with a cross, in the colors of an error. */
export const FailIcon = (props: Props) => (
  <svg viewBox="0 0 24 24" aria-hidden {...props}>
    <circle cx="12" cy="12" r="11" fill="var(--color-error)" />
    <path d="M8 8l8 8M16 8l-8 8" stroke="var(--color-on-error)" strokeWidth={2.6} strokeLinecap="round" />
  </svg>
);
export const StopIcon = (props: Props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <rect x="5" y="5" width="14" height="14" rx="2.5" />
  </svg>
);
export const WarnIcon = (props: Props) => (
  <svg {...base} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 3L2 21h20L12 3z" />
    <path d="M12 10v5M12 18v.5" />
  </svg>
);
export const MoonIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </svg>
);
export const TerminalIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 7l5 5-5 5" />
    <path d="M12 18h8" />
  </svg>
);
export const SubAgentIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
    <path d="M7.5 11v3.5a2 2 0 0 0 2 2H13" />
  </svg>
);
export const LinesIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" {...props}>
    <path d="M5 7h14M5 12h14M5 17h14" />
  </svg>
);
/** Not known: a dashed circle, faint. */
export const UnknownIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeDasharray="3 3" {...props}>
    <circle cx="12" cy="12" r="8" />
  </svg>
);
export const DashIcon = (props: Props) => (
  <svg {...base} strokeWidth={2.4} strokeLinecap="round" {...props}>
    <path d="M6 12h12" />
  </svg>
);
export const ArrowRightIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const ChevronRightIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const ChevronLeftIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const ChevronDownIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
