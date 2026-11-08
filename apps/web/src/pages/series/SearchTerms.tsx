// The series' search terms and aliases (spec §4.3), edited in place.

import { Alert, Button, Group, Stack, TagsInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { orpc } from "../../api";
import { type Series, useRefreshSeries } from "./shared";

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Remount it (`key`) when the saved terms change, so it starts from them. */
export function SearchTermsForm({ series }: { series: Series }) {
  const savedSearch = series.searchTerms.filter((t) => t.kind === "search").map((t) => t.term);
  const savedAliases = series.searchTerms.filter((t) => t.kind === "alias").map((t) => t.term);
  const [search, setSearch] = useState(savedSearch);
  const [aliases, setAliases] = useState(savedAliases);
  const refreshSeries = useRefreshSeries();

  const save = useMutation(
    orpc.series.replaceSearchTerms.mutationOptions({
      onSuccess: () => {
        notifications.show({ message: "Search terms saved", color: "green" });
        void refreshSeries(series.id);
      },
    }),
  );

  const dirty = !sameList(search, savedSearch) || !sameList(aliases, savedAliases);
  const reset = () => {
    setSearch(savedSearch);
    setAliases(savedAliases);
    save.reset();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({
          id: series.id,
          terms: [
            ...search.map((term) => ({ term, kind: "search" as const })),
            ...aliases.map((term) => ({ term, kind: "alias" as const })),
          ],
        });
      }}
    >
      <Stack>
        <TagsInput
          label="Search terms"
          description="Each one is a Prowlarr query, and is also accepted when matching results."
          value={search}
          onChange={setSearch}
          error={search.length === 0 ? "Give at least one search term" : undefined}
        />
        <TagsInput
          label="Aliases"
          description="Accepted when matching results, never searched."
          value={aliases}
          onChange={setAliases}
        />
        {save.error && (
          <Alert color="red" variant="light">
            {save.error.message}
          </Alert>
        )}
        {dirty && (
          <Group>
            <Button type="submit" loading={save.isPending} disabled={search.length === 0}>
              Save
            </Button>
            <Button variant="subtle" onClick={reset}>
              Cancel
            </Button>
          </Group>
        )}
      </Stack>
    </form>
  );
}
