export function getIndexFromTrackId(uris: string[], trackId?: string | null) {
  if (!trackId) return -1;
  const target = String(trackId);
  return uris.findIndex((uri) => uri.split(":").pop() === target);
}

export function buildShuffleOrder(
  count: number,
  startIndex: number,
  random: () => number = Math.random
) {
  const safeCount = Math.max(0, Math.floor(count));
  const indices = Array.from({ length: safeCount }, (_, index) => index);
  if (safeCount <= 1) return indices;
  const safeStartIndex = Math.max(0, Math.min(safeCount - 1, Math.floor(startIndex)));
  const rest = indices.filter((index) => index !== safeStartIndex);
  for (let index = rest.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [rest[index], rest[swapIndex]] = [rest[swapIndex], rest[index]];
  }
  return [safeStartIndex, ...rest];
}
