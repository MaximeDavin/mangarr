// Interactive search (spec §7.2, §9.4): every search term on the language's indexers, then Grab
// (§7.3). Opening the modal searches; the server keeps those results 30 minutes for Grab.

import { Alert, Anchor, Badge, Button, Group, Stack, Switch, Table, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type client, orpc } from "../../api";
import { ButtonLink } from "../../components/links";
import { RoutePending } from "../../components/RouteStatus";
import { formatAge, formatBytes, formatVolumes } from "../../format";
import { type Series, useRefreshSeries } from "./shared";

type SearchOutput = Awaited<ReturnType<typeof client.releases.search>>;
type Result = SearchOutput["results"][number];

const matchColor = { exact: "green", partial: "yellow", none: "gray" } as const;
const matchHelp = {
  exact: "The release title reads as one of the series' search terms or aliases.",
  partial: "The release title contains one of the series' names, with more around it.",
  none: "None of the series' names were found in the release title.",
} as const;

export function ReleaseSearch({ series }: { series: Series }) {
  const search = useQuery(
    orpc.releases.search.queryOptions({
      input: { id: series.id },
      // Each opening searches again: Grab only works on the latest results.
      staleTime: 0,
      gcTime: 0,
      throwOnError: false,
    }),
  );
  const [hideNoMatch, setHideNoMatch] = useState(false);

  if (search.error) {
    const needsSettings = search.error instanceof ORPCError && search.error.code === "PRECONDITION_FAILED";
    return (
      <Stack align="flex-start">
        <Alert color="red" variant="light" w="100%">
          {search.error.message}
        </Alert>
        <Group>
          <Button variant="light" loading={search.isFetching} onClick={() => search.refetch()}>
            Search again
          </Button>
          {needsSettings && (
            <ButtonLink to="/settings/languages" variant="subtle">
              Open settings
            </ButtonLink>
          )}
        </Group>
      </Stack>
    );
  }
  if (!search.data || search.isFetching) {
    return (
      <Stack align="center" gap="xs" py="xl">
        <RoutePending />
        <Text size="sm" c="dimmed">
          Searching {series.searchTerms.filter((t) => t.kind === "search").length} term(s) on Prowlarr…
        </Text>
      </Stack>
    );
  }

  const { results, queries, received, chapterReleases, usenetReleases } = search.data;
  const shown = hideNoMatch ? results.filter((r) => r.match !== "none") : results;
  const dropped = [
    chapterReleases > 0 && `${chapterReleases} chapter release${chapterReleases === 1 ? "" : "s"}`,
    usenetReleases > 0 && `${usenetReleases} Usenet`,
  ].filter(Boolean);

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Text size="sm" c="dimmed" maw={560}>
          Searched {queries.map((q) => `“${q}”`).join(", ")} on the {series.language.name} indexers: {received} result{received === 1 ? "" : "s"}
          {dropped.length > 0 && `, without ${dropped.join(" and ")}`}, {results.length} after removing duplicates.
        </Text>
        <Group gap="md">
          <Switch label="Hide no title match" checked={hideNoMatch} onChange={(e) => setHideNoMatch(e.currentTarget.checked)} />
          <Button size="xs" variant="light" onClick={() => search.refetch()}>
            Search again
          </Button>
        </Group>
      </Group>

      {shown.length === 0 ? (
        <Text c="dimmed">{results.length === 0 ? "No release found." : "Every result was hidden: none matches the title."}</Text>
      ) : (
        <Table.ScrollContainer minWidth={860}>
          <Table verticalSpacing="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Match</Table.Th>
                <Table.Th>Release</Table.Th>
                <Table.Th ta="right">Size</Table.Th>
                <Table.Th ta="right">Seeders</Table.Th>
                <Table.Th>Indexer</Table.Th>
                <Table.Th ta="right">Age</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((result) => (
                <ResultRow key={result.guid} series={series} result={result} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

function ResultRow({ series, result }: { series: Series; result: Result }) {
  const volumes = result.volumes.length > 0 ? formatVolumes(result.volumes) : result.isComplete ? "Complete" : "";
  const hints = [result.group, result.editionHint, result.source, result.contentHint, result.hasExtraChapters && "extra chapters"].filter(
    (h): h is string => Boolean(h),
  );

  return (
    <Table.Tr style={result.grabbed ? { opacity: 0.6 } : undefined}>
      <Table.Td miw={84}>
        <Tooltip label={matchHelp[result.match]} multiline maw={280} withArrow>
          <Badge color={matchColor[result.match]} variant="light" size="sm" style={{ overflow: "visible" }}>
            {result.match}
          </Badge>
        </Tooltip>
      </Table.Td>
      <Table.Td maw={460}>
        {result.infoUrl ? (
          <Anchor href={result.infoUrl} target="_blank" rel="noreferrer" size="sm" style={{ wordBreak: "break-word" }}>
            {result.title}
          </Anchor>
        ) : (
          <Text size="sm" style={{ wordBreak: "break-word" }}>
            {result.title}
          </Text>
        )}
        <Group gap={6} mt={4}>
          {volumes && (
            <Text size="xs" fw={500}>
              {volumes}
            </Text>
          )}
          {result.coversMissing && (
            <Badge size="xs" color="green" variant="dot" tt="none">
              {result.newVolumes.length > 0 ? `brings ${formatVolumes(result.newVolumes)}` : "brings missing volumes"}
            </Badge>
          )}
          {hints.map((hint) => (
            <Badge key={hint} size="xs" variant="outline" color="gray" tt="none">
              {hint}
            </Badge>
          ))}
        </Group>
      </Table.Td>
      <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
        <Text size="sm">{formatBytes(result.size)}</Text>
      </Table.Td>
      <Table.Td ta="right">
        <Text size="sm" c={result.seeders ? undefined : "red"}>
          {result.seeders ?? "?"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{result.indexer}</Text>
      </Table.Td>
      <Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
        <Text size="sm" c="dimmed">
          {result.publishDate ? formatAge(result.publishDate) : ""}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap" justify="flex-end">
          {result.match !== "exact" && result.parsedTitle && <AddAlias series={series} title={result.parsedTitle} />}
          <Grab seriesId={series.id} result={result} />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function Grab({ seriesId, result }: { seriesId: number; result: Result }) {
  const queryClient = useQueryClient();
  const refreshSeries = useRefreshSeries();
  const grab = useMutation(
    orpc.releases.grab.mutationOptions({
      onSuccess: (download) => {
        // Mark it in the results on screen, so the row dims and the button becomes a badge.
        queryClient.setQueryData<SearchOutput>(
          orpc.releases.search.queryKey({ input: { id: seriesId } }),
          (old) => old && { ...old, results: old.results.map((r) => (r.guid === result.guid ? { ...r, grabbed: true } : r)) },
        );
        notifications.show({ color: "green", title: "Sent to qBittorrent", message: download.releaseTitle });
        void refreshSeries(seriesId);
        void queryClient.invalidateQueries({ queryKey: orpc.downloads.key() });
      },
      onError: (error) => notifications.show({ color: "red", title: "Could not grab", message: error.message, autoClose: false }),
    }),
  );

  if (result.grabbed) {
    return (
      <Badge variant="light" color="blue">
        Grabbed
      </Badge>
    );
  }
  return (
    <Button size="xs" loading={grab.isPending} onClick={() => grab.mutate({ id: seriesId, guid: result.guid })}>
      Grab
    </Button>
  );
}

/** Saves the release's parsed title as an alias, so the next search matches it exactly. */
function AddAlias({ series, title }: { series: Series; title: string }) {
  const refreshSeries = useRefreshSeries();
  const known = series.searchTerms.some((t) => t.term.toLowerCase() === title.toLowerCase());
  const add = useMutation(
    orpc.series.addSearchTerm.mutationOptions({
      onSuccess: () => {
        notifications.show({ color: "green", message: `“${title}” added as an alias. Search again to see it match.` });
        void refreshSeries(series.id);
      },
      onError: (error) => notifications.show({ color: "red", title: "Could not add the alias", message: error.message }),
    }),
  );

  if (known || add.isSuccess) return null;
  return (
    <Tooltip label={`Add “${title}” as an alias`} withArrow>
      <Button size="xs" variant="subtle" loading={add.isPending} onClick={() => add.mutate({ id: series.id, term: title, kind: "alias" })}>
        Add alias
      </Button>
    </Tooltip>
  );
}
