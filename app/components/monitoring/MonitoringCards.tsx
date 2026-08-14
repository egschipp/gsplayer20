"use client";

import { useId } from "react";
import { clamp01, pillClass, toneClass, type MonitoringTone } from "./presentation";

export function HelpTip({ label, text }: { label: string; text: string }) {
  const tipId = useId();
  return (
    <span className="ops-help-tip">
      <button
        type="button"
        className="ops-help-tip-btn"
        aria-label={`${label}: explanation`}
        aria-describedby={tipId}
      >
        i
      </button>
      <span id={tipId} role="tooltip" className="ops-help-tip-popover">
        {text}
      </span>
    </span>
  );
}

export function KpiCard({
  title,
  value,
  subtitle,
  tone,
  meter,
  hint,
  details,
  featured = false,
}: {
  title: string;
  value: string;
  subtitle: string;
  tone: MonitoringTone;
  meter: number;
  hint: string;
  details?: Array<{ label: string; value: string }>;
  featured?: boolean;
}) {
  return (
    <article
      className={`ops-kpi ${toneClass(tone)}${featured ? " ops-kpi-featured" : ""}`}
    >
      <div className="ops-kpi-head">
        <span className="ops-kpi-title">{title}</span>
        <HelpTip label={title} text={hint} />
      </div>
      <div className="ops-kpi-value">{value}</div>
      <div className="ops-kpi-subtitle">{subtitle}</div>
      {details?.length ? (
        <div className="ops-kpi-details">
          {details.map((detail) => (
            <div key={detail.label} className="ops-kpi-detail">
              <span className="ops-kpi-detail-label">{detail.label}</span>
              <span className="ops-kpi-detail-value">{detail.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="ops-kpi-meter" aria-hidden="true">
        <span style={{ width: `${Math.max(5, clamp01(meter) * 100)}%` }} />
      </div>
    </article>
  );
}

export function AlertCard({
  item,
}: {
  item: { tone: MonitoringTone; title: string; text: string };
}) {
  return (
    <article className={`ops-alert-card ${toneClass(item.tone)}`}>
      <span className={pillClass(item.tone)}>
        {item.tone === "ok"
          ? "Alles ok"
          : item.tone === "warn"
            ? "Let op"
            : "Actie nodig"}
      </span>
      <strong>{item.title}</strong>
      <p className="text-subtle">{item.text}</p>
    </article>
  );
}
