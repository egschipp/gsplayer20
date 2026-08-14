import type { Mode, PlaylistOption } from "./types";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const TRACK_PAGE_SIZE = 100;
const TRACK_PAGE_SIZE_LIKED = 50;
const TRACK_LIST_WARMUP_TARGET = 500;

export const TRACK_LIST_PREFETCH_DELAY_MS = 90;

export function safeReadStorage(storage: Storage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeWriteStorage(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemoveStorageKey(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function buildApiUrl(
  path: string,
  params?: Record<string, string | null | undefined>
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null || value === "") continue;
    query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function parseRetryAfterMs(headers: Headers) {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.floor(seconds * 1000));
  }
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

export function getTrackPageSize(
  mode: Mode,
  playlistType?: PlaylistOption["type"] | null
) {
  return mode === "playlists" && playlistType === "liked"
    ? TRACK_PAGE_SIZE_LIKED
    : TRACK_PAGE_SIZE;
}

export function getTrackPrefetchMaxPages(pageSize: number) {
  return Math.max(1, Math.ceil((TRACK_LIST_WARMUP_TARGET - pageSize) / pageSize));
}

export function getFocusableElements(root: HTMLElement | null) {
  if (!root) return [] as HTMLElement[];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

export function trapTabWithin(event: KeyboardEvent, root: HTMLElement | null) {
  if (event.key !== "Tab" || !root) return;
  const focusable = getFocusableElements(root);
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey) {
    if (active === first || !active || !root.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last) {
    event.preventDefault();
    first.focus();
  }
}
