import { AspectRatio, Badge, Card, Center, Group, Image, SegmentedControl, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { orpc } from "../api";
import { ButtonLink, CardLink } from "../components/links";
import { RoutePending } from "../components/RouteStatus";

const route = getRouteApi("/_app/");

/** Spec §9.1: a grid of covers, with a language filter and owned/total counts. */
export function SeriesListPage() {
  const { language } = route.useSearch();
  const navigate = useNavigate({ from: "/" });

  // Plain queries rather than suspense, so the current grid stays on screen while another
  // language loads. Errors still go to the route's error screen (api.ts).
  const languages = useQuery(orpc.languages.list.queryOptions());
  const series = useQuery(orpc.series.list.queryOptions({ input: { language }, placeholderData: keepPreviousData }));

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Series</Title>
        <ButtonLink to="/series/add">Add series</ButtonLink>
      </Group>

      {languages.data && languages.data.length > 1 && (
        <SegmentedControl
          w="fit-content"
          value={language ?? ""}
          onChange={(value) => navigate({ search: { language: value || undefined } })}
          data={[{ value: "", label: "All" }, ...languages.data.map((l) => ({ value: l.code, label: l.name }))]}
        />
      )}

      {!series.data || !languages.data ? (
        <RoutePending />
      ) : series.data.length === 0 ? (
        <EmptyState hasLanguages={languages.data.length > 0} filtered={language !== undefined} />
      ) : (
        <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5, xl: 7 }}>
          {series.data.map((s) => (
            <CardLink key={s.id} to="/series/$id" params={{ id: s.id }} padding="xs" withBorder>
              <Card.Section>
                <AspectRatio ratio={2 / 3}>
                  {s.coverUrl ? (
                    <Image src={s.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <Center bg="var(--mantine-color-default-hover)">
                      <Text c="dimmed" size="xs">
                        No cover
                      </Text>
                    </Center>
                  )}
                </AspectRatio>
              </Card.Section>
              <Text fw={500} size="sm" mt="xs" lineClamp={2}>
                {s.displayTitle}
              </Text>
              <Group justify="space-between" mt={4}>
                <Text size="xs" c="dimmed">
                  {s.ownedCount} / {s.volumeCount ?? "?"}
                </Text>
                <Badge size="xs" variant="light">
                  {s.languageCode}
                </Badge>
              </Group>
            </CardLink>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

function EmptyState({ hasLanguages, filtered }: { hasLanguages: boolean; filtered: boolean }) {
  if (!hasLanguages) {
    return (
      <Stack align="flex-start" gap="xs">
        <Text>Add a language first: it sets the indexers, library folder and Komga library for its series.</Text>
        <ButtonLink to="/settings/languages" variant="light">
          Open settings
        </ButtonLink>
      </Stack>
    );
  }
  return <Text c="dimmed">{filtered ? "No series in this language yet." : "No series yet."}</Text>;
}
