// Activity (spec §9.5): the queue (downloads that need attention first, then qBittorrent's live
// progress) and the history of imports, each with its import log (§7.4).

import {
  Alert,
  AspectRatio,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Image,
  Progress,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  useMutation,
  usePrefetchInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type client, orpc } from "../api";
import { AnchorLink, ButtonLink } from "../components/links";
import { formatAge, formatBytes, formatDuration, formatVolumes } from "../format";

type DownloadList = Awaited<ReturnType<typeof client.downloads.list>>;
type Download = DownloadList["downloads"][number];
type LogEntry = Awaited<ReturnType<typeof client.downloads.get>>["importLog"][number];

/** Imports per page of the history. */
const historyStep = 20;

/** Refreshes while something can still change on its own; a download that needs attention waits for a retry. */
function refreshInterval(list: DownloadList | undefined): number | false {
  return list?.downloads.some((d) => d.status !== "needs_attention") ? 5_000 : false;
}

/** Everything not imported yet. Only this part refreshes, so the history isn't sent again each time. */
const queueOptions = orpc.downloads.list.queryOptions({
  input: { statuses: ["needs_attention", "downloading", "importing", "missing_from_client"], limit: 500 },
  refetchInterval: (query) => refreshInterval(query.state.data),
});

/** Newest import first (a retried old download goes to the top), a page at a time. */
const historyOptions = orpc.downloads.list.infiniteOptions({
  input: (offset: number) => ({ statuses: ["imported"], sort: "imported", limit: historyStep, offset }),
  initialPageParam: 0,
  getNextPageParam: (last, pages) => {
    const loaded = pages.reduce((n, page) => n + page.downloads.length, 0);
    return loaded < last.total ? loaded : undefined;
  },
});

export function ActivityPage() {
  const queryClient = useQueryClient();
  usePrefetchInfiniteQuery(historyOptions); // Both load at once rather than one after the other.
  const {
    data: { downloads: queued, clientError },
  } = useSuspenseQuery(queueOptions);
  const history = useSuspenseInfiniteQuery(historyOptions);

  // Those that need attention first; the sort keeps newest grabbed first otherwise.
  const queue = [...queued].sort(
    (a, b) => Number(b.status === "needs_attention") - Number(a.status === "needs_attention"),
  );
  const imported = history.data.pages.flatMap((page) => page.downloads);
  const importedTotal = history.data.pages.at(-1)!.total;

  // A finished import leaves the queue for the history: load the history again then.
  const queueIds = queued.map((d) => d.id).join();
  const previousQueueIds = useRef(queueIds);
  useEffect(() => {
    const before = previousQueueIds.current.split(",");
    previousQueueIds.current = queueIds;
    if (before.some((id) => id && !queueIds.split(",").includes(id))) {
      void queryClient.invalidateQueries({ queryKey: historyOptions.queryKey });
    }
  }, [queueIds, queryClient]);

  if (queue.length === 0 && importedTotal === 0) {
    return (
      <Stack align="flex-start">
        <Title order={2}>Activity</Title>
        <Text c="dimmed">Nothing grabbed yet. Open a series and search for its releases to grab one.</Text>
        <ButtonLink to="/" variant="light">
          Go to the series
        </ButtonLink>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Title order={2}>Activity</Title>

      {clientError && (
        <Alert color="orange" variant="light" title="qBittorrent can't be reached, so progress isn't shown">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{clientError}</Text>
            <ButtonLink to="/settings/download-clients" size="xs" variant="light" color="orange">
              Download client settings
            </ButtonLink>
          </Stack>
        </Alert>
      )}

      <Section title="Queue" count={queue.length}>
        {queue.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing downloading.
          </Text>
        ) : (
          queue.map((d) => (
            <DownloadRow key={d.id} download={d} aside={d.status === "needs_attention" && <RetryImport download={d} />}>
              <QueueStatus download={d} clientError={clientError} />
            </DownloadRow>
          ))
        )}
      </Section>

      <Section title="History" count={importedTotal}>
        {imported.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing imported yet.
          </Text>
        ) : (
          <>
            {imported.map((d) => (
              <DownloadRow
                key={d.id}
                download={d}
                aside={
                  d.importedAt && (
                    <Tooltip label={d.importedAt.toLocaleString()} withArrow>
                      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                        imported {formatAge(d.importedAt)} ago
                      </Text>
                    </Tooltip>
                  )
                }
              >
                <ImportLogToggle downloadId={d.id} />
              </DownloadRow>
            ))}
            {history.hasNextPage && (
              <Button
                variant="subtle"
                size="xs"
                style={{ alignSelf: "flex-start" }}
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Show more ({importedTotal - imported.length} left)
              </Button>
            )}
          </>
        )}
      </Section>
    </Stack>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group gap="xs">
          <Title order={3} size="h4">
            {title}
          </Title>
          {count > 0 && (
            <Badge variant="light" color="gray" size="sm">
              {count}
            </Badge>
          )}
        </Group>
        {children}
      </Stack>
    </Card>
  );
}

function Cover({ url }: { url: string | null }) {
  return (
    <Box w={44} style={{ flexShrink: 0 }} visibleFrom="xs">
      <AspectRatio ratio={2 / 3}>
        {url ? (
          <Image src={url} alt="" radius="xs" />
        ) : (
          <Center bg="var(--mantine-color-default-hover)" style={{ borderRadius: "var(--mantine-radius-xs)" }} />
        )}
      </AspectRatio>
    </Box>
  );
}

/** One download: its series, the release, and what the section adds below or beside it. */
function DownloadRow({
  download: d,
  aside,
  children,
}: {
  download: Download;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const volumes = formatVolumes(d.expectedVolumes);
  const meta = [volumes, d.indexerName, formatBytes(d.size), `grabbed ${formatAge(d.grabbedAt)} ago`]
    .filter(Boolean)
    .join(" · ");

  return (
    <Group align="flex-start" wrap="nowrap" gap="md">
      <Cover url={d.series.coverUrl} />
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Group justify="space-between" align="flex-start" gap="xs">
          <AnchorLink to="/series/$id" params={{ id: d.series.id }} fw={600} size="sm">
            {d.series.displayTitle}
          </AnchorLink>
          {aside}
        </Group>
        <Text size="sm" style={{ wordBreak: "break-word" }}>
          {d.releaseTitle}
        </Text>
        <Text size="xs" c="dimmed">
          {meta}
        </Text>
        {children}
      </Stack>
    </Group>
  );
}

/** qBittorrent's state names, in words. Complete torrents (`*UP`) are waiting for the next poll. */
function stateLabel(state: string): string {
  if (/^(downloading|forcedDL)$/.test(state)) return "Downloading";
  if (/MetaDL$/i.test(state)) return "Fetching metadata";
  if (state === "stalledDL") return "Stalled";
  if (/^(paused|stopped)DL$/.test(state)) return "Paused in qBittorrent";
  if (state === "queuedDL") return "Queued in qBittorrent";
  if (state.startsWith("checking")) return "Checking";
  if (state === "moving") return "Moving";
  if (state === "missingFiles") return "Files missing";
  if (state === "error") return "Error in qBittorrent";
  if (/UP$/.test(state)) return "Complete, import pending";
  return state;
}

/** The status line under a queued download: its problem, the import running, or qBittorrent's progress. */
function QueueStatus({ download: d, clientError }: { download: Download; clientError: string | null }) {
  if (d.status === "needs_attention") {
    return (
      <>
        {d.statusMessage && (
          <Text size="sm" c="orange">
            {d.statusMessage}
          </Text>
        )}
        <ImportLogToggle downloadId={d.id} />
      </>
    );
  }
  if (d.status === "importing") {
    return (
      <Stack gap={4}>
        <Progress value={100} striped animated size="sm" />
        <Text size="xs" c="dimmed">
          Importing…
        </Text>
      </Stack>
    );
  }
  if (d.status === "missing_from_client") {
    return (
      <Text size="sm" c="orange">
        {d.statusMessage ?? "The torrent is no longer in qBittorrent"}. It goes back to downloading if the torrent shows
        up again.
      </Text>
    );
  }
  // When qBittorrent can't be reached, the alert at the top says so.
  if (!d.client) {
    return clientError ? null : (
      <Text size="xs" c="dimmed">
        Not found in qBittorrent.
      </Text>
    );
  }

  const { state, progress, eta, downloadSpeed } = d.client;
  const color = /^(error|missingFiles)$/.test(state)
    ? "red"
    : /^(stalled|paused|stopped)/.test(state)
      ? "yellow"
      : progress >= 1
        ? "green"
        : "blue";
  const details = [
    `${Math.floor(progress * 1000) / 10}%`,
    stateLabel(state),
    downloadSpeed > 0 && `${formatBytes(downloadSpeed)}/s`,
    eta !== undefined && progress < 1 && `${formatDuration(eta)} left`,
  ].filter(Boolean);

  return (
    <Stack gap={4}>
      <Progress value={progress * 100} size="sm" color={color} />
      <Text size="xs" c="dimmed">
        {details.join(" · ")}
      </Text>
    </Stack>
  );
}

function RetryImport({ download }: { download: Download }) {
  const queryClient = useQueryClient();
  const retry = useMutation(
    orpc.downloads.retryImport.mutationOptions({
      onSuccess: () => {
        notifications.show({ message: `Importing ${download.series.displayTitle} again` });
        // Returned, so the button keeps loading until the list shows the import running.
        return queryClient.invalidateQueries({ queryKey: orpc.downloads.list.key() });
      },
      onError: (error) =>
        notifications.show({ color: "red", title: "Could not retry the import", message: error.message }),
    }),
  );

  return (
    <Button size="xs" variant="light" loading={retry.isPending} onClick={() => retry.mutate({ id: download.id })}>
      Retry import
    </Button>
  );
}

function ImportLogToggle({ downloadId }: { downloadId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap={4} align="flex-start">
      <Button variant="subtle" size="compact-xs" px={0} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide import log" : "Show import log"}
      </Button>
      {open && <ImportLog downloadId={downloadId} />}
    </Stack>
  );
}

const actionLabel: Record<LogEntry["action"], { label: string; color: string }> = {
  imported: { label: "Imported", color: "green" },
  skipped_owned: { label: "Already owned", color: "gray" },
  skipped_unparseable: { label: "No volume number", color: "orange" },
  skipped_format: { label: "Unsupported format", color: "gray" },
  error: { label: "Error", color: "red" },
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The files of the last import attempt, in torrent order. */
function ImportLog({ downloadId }: { downloadId: number }) {
  const log = useQuery(
    orpc.downloads.get.queryOptions({
      input: { id: downloadId },
      select: (d) => d.importLog,
      // Each attempt replaces the log: read it fresh whenever it's shown.
      staleTime: 0,
      throwOnError: false,
    }),
  );

  if (log.error) {
    return (
      <Text size="xs" c="red">
        Could not load the import log: {log.error.message}
      </Text>
    );
  }
  if (!log.data) {
    return (
      <Text size="xs" c="dimmed">
        Loading…
      </Text>
    );
  }
  if (log.data.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No file was looked at.
      </Text>
    );
  }

  return (
    <Table.ScrollContainer minWidth={560} w="100%">
      <Table verticalSpacing={4} fz="xs" withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>File</Table.Th>
            <Table.Th>Result</Table.Th>
            <Table.Th ta="right">Volume</Table.Th>
            <Table.Th>Detail</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {log.data.map((entry) => {
            const action = actionLabel[entry.action];
            return (
              <Table.Tr key={entry.id}>
                <Table.Td ff="monospace" style={{ wordBreak: "break-all" }}>
                  {entry.sourceFile}
                </Table.Td>
                <Table.Td style={{ whiteSpace: "nowrap" }}>
                  <Badge size="xs" variant="light" color={action.color} tt="none" style={{ overflow: "visible" }}>
                    {action.label}
                  </Badge>
                </Table.Td>
                <Table.Td ta="right">{entry.volumeNumber ?? ""}</Table.Td>
                <Table.Td style={{ wordBreak: "break-word" }}>
                  {entry.message ??
                    (entry.destPath && (
                      <Tooltip label={entry.destPath} withArrow>
                        <Text span size="xs" ff="monospace">
                          → {fileName(entry.destPath)}
                        </Text>
                      </Tooltip>
                    ))}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
