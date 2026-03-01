"use client";

import { useSyncExternalStore } from "react";
import {
  getViewportServerSnapshot,
  getViewportSnapshot,
  subscribeViewport,
  type ViewportSnapshot,
} from "./viewportStore";

export function useViewport(): ViewportSnapshot {
  return useSyncExternalStore(
    subscribeViewport,
    getViewportSnapshot,
    getViewportServerSnapshot
  );
}
