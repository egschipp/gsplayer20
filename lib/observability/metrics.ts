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

const DEFAULT_BUCKETS = [50, 100, 200, 400, 800, 1200, 2000, 5000];
const counters = new Map<string, CounterEntry>();
const histograms = new Map<string, HistogramEntry>();

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

export function incCounter(name: string, labels: Labels = {}, delta = 1): void {
  const norm = normalizeLabels(labels);
  const key = keyFor(name, norm);
  const current = counters.get(key);
  if (current) {
    current.value += delta;
    return;
  }
  counters.set(key, { name, labels: norm, value: delta });
}

export function observeHistogram(
  name: string,
  value: number,
  labels: Labels = {},
  buckets = DEFAULT_BUCKETS
): void {
  const norm = normalizeLabels(labels);
  const key = keyFor(name, norm);
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

export function clearMetrics(): void {
  counters.clear();
  histograms.clear();
}

