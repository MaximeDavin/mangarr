import { Alert, Button, Card, Group, Stack, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { orpc } from "../api";

/** Spec §6.5: search the dataset by title and pick the matching row by hand. */
export function MangaNewsPicker({
  value,
  onChange,
  initialQuery,
  linkedTitle,
  description = "Optional. Link the matching series to take its French publisher and volume count.",
}: {
  value: number | undefined;
  onChange: (id: number | undefined) => void;
  initialQuery: string;
  /** The title of the row already linked, for when it isn't among the results. */
  linkedTitle?: string;
  description?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced] = useDebouncedValue(query.trim(), 300);
  const results = useQuery(
    orpc.mangaNews.search.queryOptions({ input: { query: debounced }, enabled: debounced !== "", throwOnError: false }),
  );
  const selected = results.data?.find((r) => r.id === value);

  return (
    <Stack gap="xs">
      <TextInput label="Manga-News" description={description} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      {results.error && (
        <Alert color="orange" variant="light">
          {results.error.message}
        </Alert>
      )}
      {value !== undefined && (
        <Alert color="green" variant="light">
          <Group justify="space-between">
            <Text size="sm">Linked: {selected?.displayTitle ?? linkedTitle ?? `row ${value}`}</Text>
            <Button size="compact-xs" variant="subtle" onClick={() => onChange(undefined)}>
              Unlink
            </Button>
          </Group>
        </Alert>
      )}
      {results.data?.map((row) => (
        <Card key={row.id} withBorder padding="xs">
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0}>
              <Text size="sm" fw={500}>
                {row.displayTitle}
              </Text>
              <Text size="xs" c="dimmed">
                {[row.publisher, row.volumeCount ? `${row.volumeCount} volumes` : "announced", row.writers].filter(Boolean).join(" · ")}
              </Text>
            </Stack>
            <Button size="xs" variant={row.id === value ? "filled" : "light"} onClick={() => onChange(row.id)}>
              {row.id === value ? "Linked" : "Link"}
            </Button>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
