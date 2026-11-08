// Editing a series (spec §9.3): display title, authors, volume count and the Manga-News link.
// Search terms are edited on the page itself.

import { Alert, Button, Group, NumberInput, Stack, TagsInput, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { orpc } from "../../api";
import { MangaNewsPicker } from "../../components/MangaNewsPicker";
import { type Series, useSetSeries } from "./shared";

const countSource = { mangabaka: "MangaBaka", manganews: "Manga-News", manual: "entered by hand" } as const;

export function EditSeriesForm({ series, onDone }: { series: Series; onDone: () => void }) {
  const [displayTitle, setDisplayTitle] = useState(series.displayTitle);
  const [authors, setAuthors] = useState(series.authors);
  const [count, setCount] = useState<number | string>(series.volumeCount ?? "");
  const [countTouched, setCountTouched] = useState(false);
  const [mangaNewsId, setMangaNewsId] = useState<number | undefined>(series.mangaNewsSeriesId ?? undefined);
  const languages = useQuery(orpc.languages.list.queryOptions());
  const setSeries = useSetSeries();

  const update = useMutation(
    orpc.series.update.mutationOptions({
      onSuccess: (updated) => {
        setSeries(updated);
        notifications.show({ message: "Series saved", color: "green" });
        onDone();
      },
    }),
  );

  const usesMangaNews = languages.data?.find((l) => l.id === series.languageId)?.useMangaNewsDataset ?? false;
  const linkChanged = mangaNewsId !== (series.mangaNewsSeriesId ?? undefined);
  const titleChanged = displayTitle.trim() !== series.displayTitle;

  const submit = () =>
    update.mutate({
      id: series.id,
      ...(titleChanged && { displayTitle }),
      authors,
      ...(countTouched && { volumeCount: typeof count === "number" ? count : null }),
      ...(linkChanged && { mangaNewsSeriesId: mangaNewsId ?? null }),
    });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack>
        <TextInput
          label="Display title"
          description="Names the volume files. The folder keeps its name."
          required
          value={displayTitle}
          onChange={(e) => setDisplayTitle(e.currentTarget.value)}
        />
        <TagsInput label="Authors" description="Lets releases with the author's name in front match." value={authors} onChange={setAuthors} />
        <div>
          <NumberInput
            label="Volume count"
            description="Only used to show which volumes are missing. Leave empty if unknown."
            min={1}
            allowDecimal={false}
            value={count}
            onChange={(value) => {
              setCount(value);
              setCountTouched(true);
            }}
          />
          <Text size="xs" c="dimmed" mt={4}>
            {countTouched
              ? "Saved as entered by hand: refreshing metadata won't change it."
              : series.volumeCountSource && `From ${countSource[series.volumeCountSource]}.`}
          </Text>
        </div>

        {(usesMangaNews || series.mangaNews) && (
          <MangaNewsPicker
            value={mangaNewsId}
            onChange={setMangaNewsId}
            initialQuery={series.mangaNews?.displayTitle ?? series.displayTitle}
            linkedTitle={series.mangaNews?.displayTitle}
            description="Linking a row takes its French publisher and, unless you set the count above, its volume count."
          />
        )}

        {update.error && (
          <Alert color="red" variant="light">
            {update.error.message}
          </Alert>
        )}
        <Group>
          <Button type="submit" loading={update.isPending} disabled={!displayTitle.trim()}>
            Save
          </Button>
          <Button variant="subtle" onClick={onDone}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
