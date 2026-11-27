import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const EyeIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const EnterIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M13 4h6v16h-6" />
    <path d="M4 12h10" />
    <path d="m10 8 4 4-4 4" />
  </svg>
);
export const LeaveIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M11 4H5v16h6" />
    <path d="M10 12h10" />
    <path d="m16 8 4 4-4 4" />
  </svg>
);
export const BackIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="m15 6-6 6 6 6" />
  </svg>
);
export const ForwardIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const MoonIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </svg>
);
export const WarningIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M12 4 2.5 20h19L12 4Z" />
    <path d="M12 10v4M12 17v.5" />
  </svg>
);
export const ExternalIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M14 5h5v5" />
    <path d="M19 5 11 13" />
    <path d="M18 14v5H5V6h5" />
  </svg>
);
export const ReconnectIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v5h-5" />
  </svg>
);
