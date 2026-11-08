import {
  Alert,
  Anchor,
  AspectRatio,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Image,
  List,
  Modal,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { orpc } from "../api";
import { EditSeriesForm } from "./series/EditSeries";
import { ReleaseSearch } from "./series/ReleaseSearch";
import { SearchTermsForm } from "./series/SearchTerms";
import { type Series, useSetSeries } from "./series/shared";
import { VolumeGrid } from "./series/VolumeGrid";

const route = getRouteApi("/_app/series/$id");

/** While something downloads, the grid follows it. */
const downloadingRefresh = 15_000;

/** Spec §9.3: the volumes, the editable fields, Search / Rescan / Refresh metadata, and scan warnings. */
export function SeriesDetailPage() {
  const { id } = route.useParams();
  const { data: s } = useSuspenseQuery(
    orpc.series.get.queryOptions({
      input: { id },
      refetchInterval: (query) => (query.state.data?.downloading.length ? downloadingRefresh : false),
    }),
  );
  const [modal, setModal] = useState<"search" | "edit" | null>(null);
  const narrow = useMediaQuery("(max-width: 48em)");
  const close = () => setModal(null);

  return (
    <Stack gap="lg">
      <Header series={s} onSearch={() => setModal("search")} onEdit={() => setModal("edit")} />

      {s.scanWarnings.length > 0 && (
        <Alert color="orange" variant="light" title={`The last scan found ${s.scanWarnings.length} problem(s)`}>
          <List size="sm" spacing={2}>
            {s.scanWarnings.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only list, warnings can repeat.
              <List.Item key={i}>
                {w.file && (
                  <Text span ff="monospace" size="sm">
                    {w.file}
                  </Text>
                )}
                {w.file && ": "}
                {w.message}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      <Panel title="Volumes">
        <VolumeGrid series={s} />
      </Panel>

      <Panel title="Search terms">
        <SearchTermsForm key={s.searchTerms.map((t) => `${t.kind}:${t.term}`).join("\n")} series={s} />
      </Panel>

      <Modal
        opened={modal === "search"}
        onClose={close}
        title={`Search: ${s.displayTitle}`}
        size="80rem"
        fullScreen={narrow}
      >
        {modal === "search" && <ReleaseSearch series={s} />}
      </Modal>
      <Modal opened={modal === "edit"} onClose={close} title="Edit series" size="lg" fullScreen={narrow}>
        {modal === "edit" && <EditSeriesForm series={s} onDone={close} />}
      </Modal>
    </Stack>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder padding="lg">
      <Stack>
        <Title order={3} size="h4">
          {title}
        </Title>
        {children}
      </Stack>
    </Card>
  );
}

const countSource = { mangabaka: "from MangaBaka", manganews: "from Manga-News", manual: "entered by hand" } as const;

function externalLinks(s: Series) {
  const links = [{ label: "MangaBaka", href: `https://mangabaka.org/manga/${s.mangabakaId}` }];
  if (s.externalIds.anilist)
    links.push({ label: "AniList", href: `https://anilist.co/manga/${s.externalIds.anilist}` });
  if (s.externalIds.mal)
    links.push({ label: "MyAnimeList", href: `https://myanimelist.net/manga/${s.externalIds.mal}` });
  if (s.externalIds.mangaupdates) {
    links.push({ label: "MangaUpdates", href: `https://www.mangaupdates.com/series/${s.externalIds.mangaupdates}` });
  }
  if (s.mangaNews) links.push({ label: "Manga-News", href: s.mangaNews.url });
  return links;
}

function Header({ series: s, onSearch, onEdit }: { series: Series; onSearch: () => void; onEdit: () => void }) {
  const setSeries = useSetSeries();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const rescan = useMutation(
    orpc.series.rescan.mutationOptions({
      onSuccess: (updated) => {
        setSeries(updated);
        const warnings = updated.scanWarnings.length;
        notifications.show({
          color: warnings ? "orange" : "green",
          message: `Found ${updated.volumes.length} volume(s)${warnings ? ` and ${warnings} problem(s)` : ""}`,
        });
      },
      onError: (error) => notifications.show({ color: "red", title: "Rescan failed", message: error.message }),
    }),
  );
  const refresh = useMutation(
    orpc.series.refreshMetadata.mutationOptions({
      onSuccess: (updated) => {
        setSeries(updated);
        notifications.show({ color: "green", message: "Metadata refreshed from MangaBaka" });
      },
      onError: (error) =>
        notifications.show({ color: "red", title: "Could not refresh metadata", message: error.message }),
    }),
  );
  const remove = useMutation(
    orpc.series.delete.mutationOptions({
      onSuccess: async () => {
        notifications.show({ message: `${s.displayTitle} deleted` });
        await navigate({ to: "/" });
        queryClient.removeQueries({ queryKey: orpc.series.get.queryKey({ input: { id: s.id } }) });
        void queryClient.invalidateQueries({ queryKey: orpc.series.list.key() });
      },
      onError: (error) => notifications.show({ color: "red", title: "Could not delete", message: error.message }),
    }),
  );

  const confirmDelete = () =>
    window.confirm(`Delete ${s.displayTitle} from mangarr? Its files on disk and its torrents are left alone.`) &&
    remove.mutate({ id: s.id });

  // Owned and missing counts are in the volume grid's legend.
  const count =
    s.volumeCount !== null &&
    `${s.volumeCount} volume${s.volumeCount === 1 ? "" : "s"}${s.volumeCountSource ? `, ${countSource[s.volumeCountSource]}` : ""}`;

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Box w={{ base: 96, sm: 150 }} style={{ flexShrink: 0 }}>
        <AspectRatio ratio={2 / 3}>
          {s.coverUrl ? (
            <Image src={s.coverUrl} alt="" radius="sm" />
          ) : (
            <Center bg="var(--mantine-color-default-hover)" style={{ borderRadius: "var(--mantine-radius-sm)" }}>
              <Text c="dimmed" size="xs">
                No cover
              </Text>
            </Center>
          )}
        </AspectRatio>
      </Box>

      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
        <div>
          <Title order={2}>{s.displayTitle}</Title>
          <Group gap={6} mt={4}>
            <Badge variant="light">{s.language.name}</Badge>
            {s.status && (
              <Badge variant="outline" color="gray">
                {s.status}
              </Badge>
            )}
          </Group>
        </div>

        <Stack gap={2}>
          <Text size="sm">
            {[s.publisher, s.authors.join(", ")].filter(Boolean).join(" · ") || (
              <Text span c="dimmed">
                No publisher or author
              </Text>
            )}
          </Text>
          {count && <Text size="sm">{count}</Text>}
          <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
            {s.folderPath}
          </Text>
          <Text size="xs" c="dimmed">
            {s.lastScannedAt ? `Scanned ${s.lastScannedAt.toLocaleString()}` : "Never scanned"}
            {s.metadataFetchedAt && ` · Metadata from ${s.metadataFetchedAt.toLocaleString()}`}
          </Text>
          <Group gap="sm">
            {externalLinks(s).map((link) => (
              <Anchor key={link.label} href={link.href} target="_blank" rel="noreferrer" size="xs">
                {link.label}
              </Anchor>
            ))}
          </Group>
        </Stack>

        <Group gap="xs" mt="xs">
          <Button onClick={onSearch}>Search</Button>
          <Button variant="default" loading={rescan.isPending} onClick={() => rescan.mutate({ id: s.id })}>
            Rescan
          </Button>
          <Button variant="default" loading={refresh.isPending} onClick={() => refresh.mutate({ id: s.id })}>
            Refresh metadata
          </Button>
          <Button variant="default" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="subtle" color="red" loading={remove.isPending} onClick={confirmDelete}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Group>
  );
}
