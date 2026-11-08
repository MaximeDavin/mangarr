// Small display helpers shared by the pages.

/** `1.2 GB`; an em dash when the size is unknown (0). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Volume numbers as ranges: `v1–5, 7, 10.5`. Empty for none. */
export function formatVolumes(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    let end = start;
    // Only whole numbers run together; 10.5 stands alone.
    while (Number.isInteger(end) && sorted[i + 1] === end + 1) end = sorted[++i]!;
    parts.push(end === start ? String(start) : `${start}–${end}`);
  }
  return parts.length ? `v${parts.join(", ")}` : "";
}

/** How long ago, in the largest unit that fits: `5 min`, `3 h`, `12 d`, `4 mo`, `2 y`. */
export function formatAge(date: Date, now = Date.now()): string {
  const minutes = Math.max(0, (now - date.getTime()) / 60_000);
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} h`;
  const days = hours / 24;
  if (days < 60) return `${Math.floor(days)} d`;
  if (days < 730) return `${Math.floor(days / 30)} mo`;
  return `${Math.floor(days / 365)} y`;
}

/** A time left, in its two largest units: `45 s`, `12 min`, `3 h 5 min`, `2 d 4 h`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}
