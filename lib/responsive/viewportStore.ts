import { BREAKPOINTS, resolveBreakpoint, type BreakpointKey } from "./breakpoints";

export type ViewportOrientation = "portrait" | "landscape";

export type ViewportSnapshot = {
  width: number;
  height: number;
  visualWidth: number;
  visualHeight: number;
  dpr: number;
  orientation: ViewportOrientation;
  breakpoint: BreakpointKey;
  prefersReducedMotion: boolean;
  prefersDarkScheme: boolean;
  coarsePointer: boolean;
  hoverCapable: boolean;
};

const DEFAULT_VIEWPORT_SNAPSHOT: ViewportSnapshot = {
  width: BREAKPOINTS.laptop,
  height: 900,
  visualWidth: BREAKPOINTS.laptop,
  visualHeight: 900,
  dpr: 1,
  orientation: "landscape",
  breakpoint: resolveBreakpoint(BREAKPOINTS.laptop),
  prefersReducedMotion: false,
  prefersDarkScheme: true,
  coarsePointer: false,
  hoverCapable: true,
};

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: ViewportSnapshot = DEFAULT_VIEWPORT_SNAPSHOT;
let rafId: number | null = null;
let initialized = false;
let cleanupFn: (() => void) | null = null;

function getMediaMatch(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return fallback;
  }
  try {
    return window.matchMedia(query).matches;
  } catch {
    return fallback;
  }
}

function readSnapshot(): ViewportSnapshot {
  if (typeof window === "undefined") return snapshot;
  const visualViewport = window.visualViewport;
  const width = Math.max(0, Math.round(window.innerWidth || 0));
  const height = Math.max(0, Math.round(window.innerHeight || 0));
  const visualWidth = Math.max(
    0,
    Math.round(visualViewport?.width ?? window.innerWidth ?? 0)
  );
  const visualHeight = Math.max(
    0,
    Math.round(visualViewport?.height ?? window.innerHeight ?? 0)
  );
  const orientation: ViewportOrientation =
    visualWidth > visualHeight ? "landscape" : "portrait";
  const dpr =
    typeof window.devicePixelRatio === "number" && Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;

  return {
    width,
    height,
    visualWidth,
    visualHeight,
    dpr,
    orientation,
    breakpoint: resolveBreakpoint(width),
    prefersReducedMotion: getMediaMatch("(prefers-reduced-motion: reduce)", false),
    prefersDarkScheme: getMediaMatch("(prefers-color-scheme: dark)", true),
    coarsePointer: getMediaMatch("(pointer: coarse)", false),
    hoverCapable: getMediaMatch("(hover: hover)", true),
  };
}

function snapshotsEqual(a: ViewportSnapshot, b: ViewportSnapshot): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.visualWidth === b.visualWidth &&
    a.visualHeight === b.visualHeight &&
    a.dpr === b.dpr &&
    a.orientation === b.orientation &&
    a.breakpoint === b.breakpoint &&
    a.prefersReducedMotion === b.prefersReducedMotion &&
    a.prefersDarkScheme === b.prefersDarkScheme &&
    a.coarsePointer === b.coarsePointer &&
    a.hoverCapable === b.hoverCapable
  );
}

function emitIfChanged(next: ViewportSnapshot) {
  if (snapshotsEqual(snapshot, next)) return;
  snapshot = next;
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  });
}

function scheduleRefresh() {
  if (typeof window === "undefined") return;
  if (rafId !== null) return;
  rafId = window.requestAnimationFrame(() => {
    rafId = null;
    emitIfChanged(readSnapshot());
  });
}

function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  snapshot = readSnapshot();

  const onWindowResize = () => scheduleRefresh();
  const onOrientationChange = () => scheduleRefresh();
  const onViewportResize = () => scheduleRefresh();

  window.addEventListener("resize", onWindowResize, { passive: true });
  window.addEventListener("orientationchange", onOrientationChange, { passive: true });
  window.visualViewport?.addEventListener("resize", onViewportResize, {
    passive: true,
  });
  window.visualViewport?.addEventListener("scroll", onViewportResize, {
    passive: true,
  });

  cleanupFn = () => {
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("orientationchange", onOrientationChange);
    window.visualViewport?.removeEventListener("resize", onViewportResize);
    window.visualViewport?.removeEventListener("scroll", onViewportResize);
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

function teardownIfIdle() {
  if (!initialized || listeners.size > 0) return;
  cleanupFn?.();
  cleanupFn = null;
  initialized = false;
}

export function subscribeViewport(listener: Listener): () => void {
  listeners.add(listener);
  initialize();
  return () => {
    listeners.delete(listener);
    teardownIfIdle();
  };
}

export function getViewportSnapshot(): ViewportSnapshot {
  if (!initialized && typeof window !== "undefined") initialize();
  return snapshot;
}

export function getViewportServerSnapshot(): ViewportSnapshot {
  return DEFAULT_VIEWPORT_SNAPSHOT;
}

export function createViewportTestSnapshot(
  overrides: Partial<ViewportSnapshot> = {}
): ViewportSnapshot {
  return { ...DEFAULT_VIEWPORT_SNAPSHOT, ...overrides };
}
