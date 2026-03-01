"use client";

import { useMemo, useSyncExternalStore } from "react";

function getMatch(query: string, fallback = false): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return fallback;
  }
  try {
    return window.matchMedia(query).matches;
  } catch {
    return fallback;
  }
}

export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useMemo(
    () => (onStoreChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => undefined;
      }
      let mediaQueryList: MediaQueryList;
      try {
        mediaQueryList = window.matchMedia(query);
      } catch {
        return () => undefined;
      }
      const handler = () => onStoreChange();
      mediaQueryList.addEventListener("change", handler);
      return () => mediaQueryList.removeEventListener("change", handler);
    },
    [query]
  );

  const getSnapshot = useMemo(() => () => getMatch(query, fallback), [fallback, query]);
  const getServerSnapshot = useMemo(() => () => fallback, [fallback]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
