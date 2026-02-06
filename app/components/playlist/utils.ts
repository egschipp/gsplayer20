export function formatDuration(ms?: number | null) {
  if (!ms || ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function formatTimestamp(ms?: number | null) {
  if (!ms || ms <= 0) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function formatExplicit(value?: number | null) {
  if (value === null || value === undefined) return "—";
  return value ? "Yes" : "No";
}

export function dedupeArtistText(value?: string | null) {
  if (!value) return "";
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.length) return "";
  const unique = Array.from(new Set(names));
  return unique.join(", ");
}

export function dedupeArtists(
  artists?: { id: string; name: string }[] | null
): { id: string; name: string }[] {
  if (!artists?.length) return [];
  const seen = new Set<string>();
  const unique: { id: string; name: string }[] = [];
  for (const artist of artists) {
    const key = `${artist.id}:${artist.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(artist);
  }
  return unique;
}
