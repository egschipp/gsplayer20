import assert from "node:assert/strict";
import test from "node:test";
import {
  authTone,
  fmtAgoShort,
  fmtCompactTime,
  fmtCount,
  fmtDateTime,
  fmtPercent,
  fmtWindow,
  formatAuthStatus,
  formatImpactLevel,
  formatLatencyHealthLabel,
  formatMonitoringActivityLabel,
  formatRateLimitSource,
  formatTokenStatus,
  tokenStatusTone,
} from "./statusPresentation";

test("formats monitoring values consistently", () => {
  assert.equal(fmtPercent(0.995), "99.5%");
  assert.equal(fmtCount(Number.NaN), "—");
  assert.equal(fmtCount(1200), "1,200");
  assert.equal(fmtWindow(0), "recent");
  assert.equal(fmtWindow(30), "30s");
  assert.equal(fmtWindow(90), "2m");
  assert.equal(fmtWindow(300), "5m");
  assert.equal(fmtAgoShort(-1), "n/a");
  assert.equal(fmtAgoShort(30), "30s");
  assert.equal(fmtAgoShort(120), "2m");
  assert.equal(fmtAgoShort(3600), "1h");
  assert.equal(fmtCompactTime(null), "n/a");
  assert.notEqual(fmtCompactTime(1_700_000_000_000), "n/a");
  assert.equal(fmtDateTime(null), "n/a");
  assert.notEqual(fmtDateTime(1_700_000_000_000), "n/a");
});

test("presents known and fallback activity labels", () => {
  assert.equal(formatMonitoringActivityLabel("me_player_transfer"), "Device handoff");
  assert.equal(
    formatMonitoringActivityLabel("custom_background_job"),
    "Custom Background Job"
  );
  assert.equal(formatMonitoringActivityLabel(null), "No hotspot");
  assert.equal(
    formatMonitoringActivityLabel("me_player_get_raw_state"),
    "Player state refresh"
  );
  assert.equal(formatMonitoringActivityLabel("v1_custom_raw_get"), "Custom Live");
});

test("maps auth and token states to user-facing status", () => {
  assert.equal(authTone("connected"), "ok");
  assert.equal(authTone("reauth_required"), "warn");
  assert.equal(authTone("failed"), "error");
  assert.equal(formatAuthStatus("CONNECTED"), "Connected");
  assert.equal(formatAuthStatus("REAUTH_REQUIRED"), "Re-login required");
  assert.equal(formatAuthStatus("DISCONNECTED"), "Disconnected");
  assert.equal(formatAuthStatus("CHECKING"), "Checking");
  assert.equal(formatAuthStatus("custom"), "custom");
  assert.equal(tokenStatusTone("valid"), "ok");
  assert.equal(tokenStatusTone("missing"), "warn");
  assert.equal(tokenStatusTone("expired"), "error");
  const tokenLabels = new Map([
    ["VALID", "Valid"],
    ["REFRESHING", "Refreshing"],
    ["EXPIRING", "Expiring soon"],
    ["EXPIRED", "Expired"],
    ["REAUTH_REQUIRED", "Re-login required"],
    ["MISSING_ACCESS", "Missing"],
    ["ERROR", "Error"],
    ["custom", "custom"],
  ]);
  for (const [status, label] of tokenLabels) {
    assert.equal(formatTokenStatus(status), label);
  }
});

test("classifies rate limits, impact and latency", () => {
  assert.equal(formatRateLimitSource("spotify_http_429"), "Spotify 429");
  assert.equal(formatRateLimitSource("spotify_local_limiter"), "Local limiter");
  assert.equal(formatRateLimitSource("custom"), "custom");
  assert.equal(formatRateLimitSource(""), "Unknown");
  assert.equal(formatImpactLevel("high"), "high");
  assert.equal(formatImpactLevel("medium"), "medium");
  assert.equal(formatImpactLevel(null), "low");
  assert.equal(formatLatencyHealthLabel(0), "Waiting for enough samples");
  assert.equal(formatLatencyHealthLabel(400), "User-facing requests feel healthy");
  assert.equal(
    formatLatencyHealthLabel(800),
    "User-facing requests are slightly elevated"
  );
  assert.equal(formatLatencyHealthLabel(1200), "User-facing requests feel slow");
});
