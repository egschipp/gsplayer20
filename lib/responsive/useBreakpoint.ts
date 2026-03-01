"use client";

import { BREAKPOINTS, type BreakpointKey, type BreakpointName } from "./breakpoints";
import { useViewport } from "./useViewport";

export type BreakpointFlags = {
  breakpoint: BreakpointKey;
  isBase: boolean;
  atLeastMobile: boolean;
  atLeastTablet: boolean;
  atLeastLaptop: boolean;
  atLeastDesktop: boolean;
  atLeastWide: boolean;
  belowTablet: boolean;
  belowLaptop: boolean;
  belowDesktop: boolean;
};

function atLeast(width: number, name: BreakpointName): boolean {
  return width >= BREAKPOINTS[name];
}

export function useBreakpoint(): BreakpointFlags {
  const { width, breakpoint } = useViewport();
  return {
    breakpoint,
    isBase: breakpoint === "base",
    atLeastMobile: atLeast(width, "mobile"),
    atLeastTablet: atLeast(width, "tablet"),
    atLeastLaptop: atLeast(width, "laptop"),
    atLeastDesktop: atLeast(width, "desktop"),
    atLeastWide: atLeast(width, "wide"),
    belowTablet: width < BREAKPOINTS.tablet,
    belowLaptop: width < BREAKPOINTS.laptop,
    belowDesktop: width < BREAKPOINTS.desktop,
  };
}
