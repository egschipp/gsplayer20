import { useCallback, useRef, useState } from "react";

export function usePlaybackCommandQueue() {
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const [busy, setBusy] = useState(false);

  const enqueue = useCallback(async (fn: () => Promise<void>) => {
    pendingRef.current += 1;
    setBusy(true);
    const next = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        await fn();
      })
      .finally(() => {
        pendingRef.current -= 1;
        if (pendingRef.current <= 0) {
          pendingRef.current = 0;
          setBusy(false);
        }
      });
    queueRef.current = next;
    return next;
  }, []);

  return { enqueue, busy };
}
