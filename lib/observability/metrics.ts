type LabelValue = string | number | boolean | null | undefined;
type Labels = Record<string, LabelValue>;

type CounterEntry = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

type HistogramEntry = {
  name: string;
  labels: Record<string, string>;
  buckets: number[];
  counts: number[];
  count: number;
  sum: number;
};

type CounterEvent = {
  name: string;
  labels: Record<string, string>;
  value: number;
  at: number;
};

type HistogramEvent = {
  name: string;
  labels: Record<string, string>;
  value: number;
  at: number;
};

const DEFAULT_BUCKETS = [50, 100, 200, 400, 800, 1200, 2000, 5000];
const RECENT_EVENT_RETENTION_MS = Number(
  process.env.OBSERVABILITY_RECENT_RETENTION_MS || "3600000"
);
const RECENT_EVENT_MAX_COUNT = Number(
  process.env.OBSERVABILITY_RECENT_MAX_EVENTS || "30000"
);
const RECENT_EVENT_PRUNE_INTERVAL_MS = 5000;
const counters = new Map<string, CounterEntry>();
const histograms = new Map<string, HistogramEntry>();
const counterEvents: CounterEvent[] = [];
const histogramEvents: HistogramEvent[] = [];
let lastRecentEventPruneAt = 0;

function normalizeLabels(labels: Labels = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const raw = labels[key];
    if (raw == null) continue;
    out[key] = String(raw).slice(0, 64);
  }
  return out;
}

function keyFor(name: string, labels: Record<string, string>): string {
  return `${name}|${JSON.stringify(labels)}`;
}

function normalizeWindowMs(windowMs: number): number {
  if (!Number.isFinite(windowMs)) return 300000;
  return Math.max(1000, Math.min(RECENT_EVENT_RETENTION_MS, Math.floor(windowMs)));
}

function pruneRecentEvents(now = Date.now()): void {
  if (
    now - lastRecentEventPruneAt < RECENT_EVENT_PRUNE_INTERVAL_MS &&
    counterEvents.length <= RECENT_EVENT_MAX_COUNT &&
    histogramEvents.length <= RECENT_EVENT_MAX_COUNT
  ) {
    return;
  }
  lastRecentEventPruneAt = now;
  const cutoff = now - RECENT_EVENT_RETENTION_MS;

  let dropCounters = 0;
  while (dropCounters < counterEvents.length && counterEvents[dropCounters].at < cutoff) {
    dropCounters += 1;
  }
  if (dropCounters > 0) {
    counterEvents.splice(0, dropCounters);
  }
  if (counterEvents.length > RECENT_EVENT_MAX_COUNT) {
    counterEvents.splice(0, counterEvents.length - RECENT_EVENT_MAX_COUNT);
  }

  let dropHistograms = 0;
  while (
    dropHistograms < histogramEvents.length &&
    histogramEvents[dropHistograms].at < cutoff
  ) {
    dropHistograms += 1;
  }
  if (dropHistograms > 0) {
    histogramEvents.splice(0, dropHistograms);
  }
  if (histogramEvents.length > RECENT_EVENT_MAX_COUNT) {
    histogramEvents.splice(0, histogramEvents.length - RECENT_EVENT_MAX_COUNT);
  }
}

export function incCounter(name: string, labels: Labels = {}, delta = 1): void {
  const norm = normalizeLabels(labels);
  const key = keyFor(name, norm);
  const now = Date.now();
  const current = counters.get(key);
  if (current) {
    current.value += delta;
    counterEvents.push({ name, labels: norm, value: delta, at: now });
    pruneRecentEvents(now);
    return;
  }
  counters.set(key, { name, labels: norm, value: delta });
  counterEvents.push({ name, labels: norm, value: delta, at: now });
  pruneRecentEvents(now);
}

export function observeHistogram(
  name: string,
  value: number,
  labels: Labels = {},
  buckets = DEFAULT_BUCKETS
): void {
  const norm = normalizeLabels(labels);
  const key = keyFor(name, norm);
  const now = Date.now();
  let entry = histograms.get(key);
  if (!entry) {
    entry = {
      name,
      labels: norm,
      buckets: [...buckets],
      counts: new Array(buckets.length).fill(0),
      count: 0,
      sum: 0,
    };
    histograms.set(key, entry);
  }
  const sample = Number.isFinite(value) ? Math.max(0, value) : 0;
  entry.count += 1;
  entry.sum += sample;
  histogramEvents.push({ name, labels: norm, value: sample, at: now });
  pruneRecentEvents(now);
  for (let i = 0; i < entry.buckets.length; i += 1) {
    if (sample <= entry.buckets[i]) {
      entry.counts[i] += 1;
    }
  }
}

function labelsMatch(
  source: Record<string, string>,
  filter: Record<string, string>
): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (source[k] !== v) return false;
  }
  return true;
}

export function counterTotal(name: string, filter: Labels = {}): number {
  const normFilter = normalizeLabels(filter);
  let total = 0;
  for (const entry of counters.values()) {
    if (entry.name !== name) continue;
    if (!labelsMatch(entry.labels, normFilter)) continue;
    total += entry.value;
  }
  return total;
}

export function counterTotalWindow(
  name: string,
  filter: Labels = {},
  windowMs = 300000,
  now = Date.now()
): number {
  const normFilter = normalizeLabels(filter);
  const cutoff = now - normalizeWindowMs(windowMs);
  let total = 0;
  for (let i = counterEvents.length - 1; i >= 0; i -= 1) {
    const event = counterEvents[i];
    if (event.at < cutoff) break;
    if (event.name !== name) continue;
    if (!labelsMatch(event.labels, normFilter)) continue;
    total += event.value;
  }
  return total;
}

export function histogramQuantiles(
  name: string,
  filter: Labels = {}
): { p50: number; p95: number; p99: number } {
  const normFilter = normalizeLabels(filter);
  const mergedCounts = new Array(DEFAULT_BUCKETS.length).fill(0);
  let mergedTotal = 0;

  for (const entry of histograms.values()) {
    if (entry.name !== name) continue;
    if (!labelsMatch(entry.labels, normFilter)) continue;
    mergedTotal += entry.count;
    for (let i = 0; i < mergedCounts.length; i += 1) {
      mergedCounts[i] += entry.counts[i] || 0;
    }
  }

  if (mergedTotal === 0) {
    return { p50: 0, p95: 0, p99: 0 };
  }

  function quantile(q: number): number {
    const target = Math.ceil(mergedTotal * q);
    for (let i = 0; i < mergedCounts.length; i += 1) {
      if (mergedCounts[i] >= target) {
        return DEFAULT_BUCKETS[i];
      }
    }
    return DEFAULT_BUCKETS[DEFAULT_BUCKETS.length - 1];
  }

  return {
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
  };
}

export function histogramQuantilesWindow(
  name: string,
  filter: Labels = {},
  windowMs = 300000,
  now = Date.now()
): { p50: number; p95: number; p99: number } {
  const normFilter = normalizeLabels(filter);
  const cutoff = now - normalizeWindowMs(windowMs);
  const samples: number[] = [];

  for (let i = histogramEvents.length - 1; i >= 0; i -= 1) {
    const event = histogramEvents[i];
    if (event.at < cutoff) break;
    if (event.name !== name) continue;
    if (!labelsMatch(event.labels, normFilter)) continue;
    samples.push(event.value);
  }

  if (!samples.length) {
    return { p50: 0, p95: 0, p99: 0 };
  }

  samples.sort((a, b) => a - b);

  function quantile(q: number): number {
    const idx = Math.max(0, Math.min(samples.length - 1, Math.ceil(samples.length * q) - 1));
    return Math.round(samples[idx]);
  }

  return {
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
  };
}

export function topCounterByLabel(
  name: string,
  label: string,
  limit = 5
): Array<{ label: string; value: number }> {
  const aggregate = new Map<string, number>();
  for (const entry of counters.values()) {
    if (entry.name !== name) continue;
    const key = entry.labels[label] || "unknown";
    aggregate.set(key, (aggregate.get(key) || 0) + entry.value);
  }
  return Array.from(aggregate.entries())
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, limit));
}

export function topCounterByLabelWindow(
  name: string,
  label: string,
  limit = 5,
  windowMs = 300000,
  now = Date.now()
): Array<{ label: string; value: number }> {
  const cutoff = now - normalizeWindowMs(windowMs);
  const aggregate = new Map<string, number>();
  for (let i = counterEvents.length - 1; i >= 0; i -= 1) {
    const event = counterEvents[i];
    if (event.at < cutoff) break;
    if (event.name !== name) continue;
    const key = event.labels[label] || "unknown";
    aggregate.set(key, (aggregate.get(key) || 0) + event.value);
  }
  return Array.from(aggregate.entries())
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, limit));
}

export function counterEntries(
  name: string,
  filter: Labels = {}
): Array<{ labels: Record<string, string>; value: number }> {
  const normFilter = normalizeLabels(filter);
  const rows: Array<{ labels: Record<string, string>; value: number }> = [];
  for (const entry of counters.values()) {
    if (entry.name !== name) continue;
    if (!labelsMatch(entry.labels, normFilter)) continue;
    rows.push({
      labels: { ...entry.labels },
      value: entry.value,
    });
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

export function counterEntriesWindow(
  name: string,
  filter: Labels = {},
  windowMs = 300000,
  now = Date.now()
): Array<{ labels: Record<string, string>; value: number }> {
  const normFilter = normalizeLabels(filter);
  const cutoff = now - normalizeWindowMs(windowMs);
  const grouped = new Map<string, { labels: Record<string, string>; value: number }>();

  for (let i = counterEvents.length - 1; i >= 0; i -= 1) {
    const event = counterEvents[i];
    if (event.at < cutoff) break;
    if (event.name !== name) continue;
    if (!labelsMatch(event.labels, normFilter)) continue;
    const key = JSON.stringify(event.labels);
    const row = grouped.get(key);
    if (row) {
      row.value += event.value;
      continue;
    }
    grouped.set(key, {
      labels: { ...event.labels },
      value: event.value,
    });
  }

  return Array.from(grouped.values()).sort((a, b) => b.value - a.value);
}

export function clearMetrics(): void {
  counters.clear();
  histograms.clear();
  counterEvents.length = 0;
  histogramEvents.length = 0;
}
