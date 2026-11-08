// Terminal formatting shared by the scripts.

/** [1, 2, 3, 5, 7, 8] → "1-3, 5, 7-8" */
export function formatVolumes(volumes: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < volumes.length; ) {
    let j = i;
    while (j + 1 < volumes.length && volumes[j + 1] === volumes[j]! + 1) j++;
    parts.push(j > i ? `${volumes[i]}-${volumes[j]}` : String(volumes[i]));
    i = j + 1;
  }
  return parts.join(", ");
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}
