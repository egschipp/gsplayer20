const activeAnimations = new WeakMap<HTMLElement, number>();

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cancelScrollAnimation(element: HTMLElement) {
  const raf = activeAnimations.get(element);
  if (typeof raf === "number") {
    window.cancelAnimationFrame(raf);
    activeAnimations.delete(element);
  }
}

export function animateScrollTop(
  element: HTMLElement | null,
  targetTop: number,
  options?: {
    minDurationMs?: number;
    maxDurationMs?: number;
    pxPerMs?: number;
  }
) {
  if (!element) return;
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  const nextTop = clamp(targetTop, 0, maxTop);
  const startTop = element.scrollTop;
  const delta = nextTop - startTop;
  if (Math.abs(delta) < 1) return;

  cancelScrollAnimation(element);
  if (prefersReducedMotion()) {
    element.scrollTop = nextTop;
    return;
  }

  const pxPerMs = Math.max(0.1, options?.pxPerMs ?? 2.2);
  const minDurationMs = Math.max(120, options?.minDurationMs ?? 340);
  const maxDurationMs = Math.max(minDurationMs, options?.maxDurationMs ?? 1050);
  const durationMs = clamp(Math.abs(delta) / pxPerMs, minDurationMs, maxDurationMs);
  const startAt = performance.now();

  const step = (now: number) => {
    const progress = clamp((now - startAt) / durationMs, 0, 1);
    const eased = easeInOutCubic(progress);
    element.scrollTop = startTop + delta * eased;
    if (progress >= 1) {
      activeAnimations.delete(element);
      return;
    }
    const raf = window.requestAnimationFrame(step);
    activeAnimations.set(element, raf);
  };

  const raf = window.requestAnimationFrame(step);
  activeAnimations.set(element, raf);
}

export function animateScrollToIndex(
  element: HTMLElement | null,
  index: number,
  rowHeight: number,
  options?: Parameters<typeof animateScrollTop>[2]
) {
  if (!element || index < 0 || rowHeight <= 0) return;
  const targetTop = index * rowHeight;
  animateScrollTop(element, targetTop, options);
}
