// The series' volumes, owned, missing or downloading (spec §9.3).

import { Box, Group, Stack, Text, Tooltip } from "@mantine/core";
import type { CSSProperties } from "react";
import { formatBytes } from "../../format";
import type { Series } from "./shared";

type State = "owned" | "downloading" | "missing";

const styles: Record<State, CSSProperties> = {
  owned: {
    background: "var(--mantine-color-green-filled)",
    color: "var(--mantine-color-white)",
    border: "1px solid var(--mantine-color-green-filled)",
  },
  downloading: {
    background: "var(--mantine-color-blue-light)",
    color: "var(--mantine-color-blue-light-color)",
    border: "1px solid var(--mantine-color-blue-filled)",
  },
  missing: {
    background: "var(--mantine-color-default)",
    color: "var(--mantine-color-dimmed)",
    border: "1px dashed var(--mantine-color-default-border)",
  },
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function Cell({ number, state, label }: { number: number; state: State; label: string }) {
  return (
    <Tooltip label={label} multiline maw={360} withArrow openDelay={150}>
      <Box
        tabIndex={0}
        aria-label={`Volume ${number}: ${label}`}
        style={{
          ...styles[state],
          minWidth: 44,
          height: 44,
          padding: "0 6px",
          borderRadius: "var(--mantine-radius-sm)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "var(--mantine-font-size-sm)",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          cursor: "default",
        }}
      >
        {number}
      </Box>
    </Tooltip>
  );
}

function Legend({ state, label }: { state: State; label: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Box style={{ ...styles[state], width: 12, height: 12, borderRadius: 3 }} />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}

export function VolumeGrid({ series }: { series: Series }) {
  const owned = new Map(series.volumes.map((v) => [v.number, v]));
  const downloading = new Set(series.downloading);
  // 1 to the volume count, plus whatever is owned beyond it (digital runs ahead, and 10.5 exists).
  const numbers = [...new Set([...series.missing, ...owned.keys()])].sort((a, b) => a - b);

  return (
    <Stack gap="sm">
      <Group gap="md">
        <Legend state="owned" label={`Owned (${series.volumes.length})`} />
        {series.volumeCount !== null && <Legend state="missing" label={`Missing (${series.missing.length - downloading.size})`} />}
        {downloading.size > 0 && <Legend state="downloading" label={`Downloading (${downloading.size})`} />}
      </Group>

      {numbers.length === 0 ? (
        <Text c="dimmed" size="sm">
          No volume on disk yet.
        </Text>
      ) : (
        <Group gap={6}>
          {numbers.map((n) => {
            const volume = owned.get(n);
            if (volume) {
              const how = volume.source === "import" ? "imported" : "found on disk";
              return <Cell key={n} number={n} state="owned" label={`${fileName(volume.filePath)} · ${formatBytes(volume.fileSize)} · ${how}`} />;
            }
            if (downloading.has(n)) return <Cell key={n} number={n} state="downloading" label="Downloading" />;
            return <Cell key={n} number={n} state="missing" label="Missing" />;
          })}
        </Group>
      )}

      {series.volumeCount === null && (
        <Text c="dimmed" size="xs">
          The volume count is unknown, so missing volumes can't be shown. Set it with Edit.
        </Text>
      )}
    </Stack>
  );
}
