"use client";

import { useCallback, useEffect, useRef } from "react";
import type { FocusEvent } from "react";

type UseStableMenuOptions = {
  onClose: () => void;
};

export function useStableMenu<T extends HTMLElement = HTMLDivElement>({
  onClose,
}: UseStableMenuOptions) {
  const rootRef = useRef<T | null>(null);
  const interactionRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markInteraction = useCallback(() => {
    interactionRef.current = true;
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      interactionRef.current = false;
      resetTimerRef.current = null;
    }, 0);
  }, []);

  const handleBlur = useCallback(
    (event: FocusEvent<T>) => {
      const nextTarget =
        (event.relatedTarget as Node | null) ?? document.activeElement;
      if (nextTarget && rootRef.current?.contains(nextTarget)) return;
      if (interactionRef.current) return;
      onClose();
    },
    [onClose]
  );

  useEffect(() => {
    const closeMenu = () => {
      onClose();
      interactionRef.current = false;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") closeMenu();
    };
    window.addEventListener("blur", closeMenu);
    window.addEventListener("pagehide", closeMenu);
    window.addEventListener("pageshow", closeMenu);
    window.addEventListener("freeze", closeMenu as EventListener);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("pagehide", closeMenu);
      window.removeEventListener("pageshow", closeMenu);
      window.removeEventListener("freeze", closeMenu as EventListener);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, [onClose]);

  return {
    rootRef,
    markInteraction,
    handleBlur,
  };
}
