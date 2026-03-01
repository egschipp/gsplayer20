export const BREAKPOINTS = {
  mobile: 360,
  tablet: 768,
  laptop: 1024,
  desktop: 1280,
  wide: 1536,
} as const;

export type BreakpointName = keyof typeof BREAKPOINTS;
export type BreakpointKey = "base" | BreakpointName;

const BREAKPOINT_SEQUENCE: Array<[BreakpointName, number]> = [
  ["mobile", BREAKPOINTS.mobile],
  ["tablet", BREAKPOINTS.tablet],
  ["laptop", BREAKPOINTS.laptop],
  ["desktop", BREAKPOINTS.desktop],
  ["wide", BREAKPOINTS.wide],
];

export function resolveBreakpoint(width: number): BreakpointKey {
  if (!Number.isFinite(width) || width <= 0) return "base";
  let current: BreakpointKey = "base";
  for (const [name, minWidth] of BREAKPOINT_SEQUENCE) {
    if (width >= minWidth) {
      current = name;
    } else {
      break;
    }
  }
  return current;
}

export function buildMinWidthQuery(minWidth: number): string {
  const normalized = Math.max(0, Math.round(minWidth));
  return `(min-width: ${normalized}px)`;
}

export function buildMaxWidthQuery(maxWidth: number): string {
  const normalized = Math.max(0, Math.round(maxWidth));
  return `(max-width: ${normalized}px)`;
}
