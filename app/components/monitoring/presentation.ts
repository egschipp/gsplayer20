export type MonitoringTone = "ok" | "warn" | "error";

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function toneClass(tone: MonitoringTone) {
  return `ops-tone-${tone}`;
}

export function pillClass(tone: MonitoringTone) {
  if (tone === "ok") return "pill pill-success";
  if (tone === "warn") return "pill pill-warn";
  return "pill pill-error";
}
