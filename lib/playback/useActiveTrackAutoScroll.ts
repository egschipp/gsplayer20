"use client";

import { useEffect, useRef } from "react";
import { animateScrollToIndex } from "@/lib/ui/smoothScroll";
import { emitPlaybackUiMetric } from "./uiTelemetry";

type UseActiveTrackAutoScrollInput = {
  enabled: boolean;
  listElement: HTMLElement | null;
  activeIndex: number;
  trackKey: string | null;
  rowHeight: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  pxPerMs?: number;
  offsetPx?: number;
  metricContext: "rows" | "items";
};

export function useActiveTrackAutoScroll(input: UseActiveTrackAutoScrollInput) {
  const lastScrollRef = useRef<{ trackKey: string | null; index: number }>({
    trackKey: null,
    index: -1,
  });

  useEffect(() => {
    if (!input.enabled) return;
    if (!input.listElement) return;
    if (input.activeIndex < 0) return;

    if (
      input.trackKey &&
      lastScrollRef.current.trackKey === input.trackKey &&
      lastScrollRef.current.index === input.activeIndex
    ) {
      return;
    }

    lastScrollRef.current = {
      trackKey: input.trackKey,
      index: input.activeIndex,
    };
    emitPlaybackUiMetric("scroll_to_active_track", {
      context: input.metricContext,
      index: input.activeIndex,
    });
    window.requestAnimationFrame(() => {
      animateScrollToIndex(input.listElement, input.activeIndex, input.rowHeight, {
        minDurationMs: input.minDurationMs ?? 420,
        maxDurationMs: input.maxDurationMs ?? 1350,
        pxPerMs: input.pxPerMs ?? 1.6,
        offsetPx: input.offsetPx ?? 8,
      });
    });
  }, [
    input.activeIndex,
    input.enabled,
    input.listElement,
    input.maxDurationMs,
    input.metricContext,
    input.minDurationMs,
    input.offsetPx,
    input.pxPerMs,
    input.rowHeight,
    input.trackKey,
  ]);
}

