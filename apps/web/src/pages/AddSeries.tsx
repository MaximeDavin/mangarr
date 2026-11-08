import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Image,
  NumberInput,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { client, orpc } from "../api";
import { ButtonLink } from "../components/links";
import { MangaNewsPicker } from "../components/MangaNewsPicker";
import { RoutePending } from "../components/RouteStatus";

type SearchResult = Awaited<ReturnType<typeof client.mangabaka.search>>[number];
type Language = Awaited<ReturnType<typeof client.languages.list>>[number];

/** Spec §7.1: pick a MangaBaka series, then review everything it pre-fills before saving. */
export function AddSeriesPage() {
  const languages = useQuery(orpc.languages.list.queryOptions());
  const [languageId, setLanguageId] = useState<string | null>(null);
  const [picked, setPicked] = useState<SearchResult | null>(null);

  if (!languages.data) return <RoutePending />;
  if (languages.data.length === 0) {
    return (
      <Stack align="flex-start">
        <Title order={2}>Add series</Title>
        <Text>Add a language in Settings first.</Text>
        <ButtonLink to="/settings/languages" variant="light">
          Open settings
        </ButtonLink>
      </Stack>
    );
  }
  const language = languages.data.find((l) => String(l.id) === languageId) ?? languages.data[0]!;

  return (
    <Stack maw={760}>
      <Title order={2}>Add series</Title>
      <Select
        label="Language"
        description="Each language has its own copy of a series, with its own indexers and folder."
        allowDeselect={false}
        data={languages.data.map((l) => ({ value: String(l.id), label: `${l.name} (${l.code})` }))}
        value={String(language.id)}
        onChange={(value) => {
          setLanguageId(value);
          setPicked(null);
        }}
      />
      {picked ? (
        <DraftForm key={`${language.id}:${picked.mangabakaId}`} language={language} picked={picked} onBack={() => setPicked(null)} />
      ) : (
        <SearchStep onPick={setPicked} />
      )}
    </Stack>
  );
}

function SearchStep({ onPick }: { onPick: (result: SearchResult) => void }) {
  const [query, setQuery] = useState("");
  // MangaBaka allows 30 searches a minute.
  const [debounced] = useDebouncedValue(query.trim(), 500);
  const results = useQuery(
    orpc.mangabaka.search.queryOptions({ input: { query: debounced }, enabled: debounced !== "", throwOnError: false }),
  );

  return (
    <Stack>
      <TextInput
        label="Search MangaBaka"
        placeholder="Title"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      {results.error && (
        <Alert color="red" variant="light">
          {results.error.message}
        </Alert>
      )}
      {results.isFetching && !results.data && <RoutePending />}
      {results.data?.length === 0 && <Text c="dimmed">No result.</Text>}
      {results.data?.map((result) => (
        <Card key={result.mangabakaId} withBorder padding="xs">
          <Group wrap="nowrap" align="flex-start">
            <Image src={result.thumbnailUrl} w={48} h={72} fit="cover" fallbackSrc="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" />
            <Stack gap={2} style={{ flex: 1 }}>
              <Text fw={500}>{result.title}</Text>
              <Text size="sm" c="dimmed">
                {[result.nativeTitle, result.year, result.authors.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}
              </Text>
              <Group gap={6}>
                <Badge size="xs" variant="light">
                  {result.type}
                </Badge>
                <Badge size="xs" variant="outline">
                  {result.status}
                </Badge>
                {result.finalVolume !== undefined && (
                  <Text size="xs" c="dimmed">
                    {result.finalVolume} volumes
                  </Text>
                )}
              </Group>
            </Stack>
            <Button size="xs" variant="light" onClick={() => onPick(result)}>
              Select
            </Button>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

function DraftForm({ language, picked, onBack }: { language: Language; picked: SearchResult; onBack: () => void }) {
  const draft = useQuery(
    orpc.series.draft.queryOptions({
      input: { mangabakaId: picked.mangabakaId, languageId: language.id },
      throwOnError: false,
      staleTime: 0,
    }),
  );

  if (draft.error) {
    return (
      <Stack align="flex-start">
        <Alert color="red" variant="light">
          {draft.error.message}
        </Alert>
        <Button variant="light" onClick={onBack}>
          Back to search
        </Button>
      </Stack>
    );
  }
  if (!draft.data) return <RoutePending />;
  return <ReviewForm language={language} draft={draft.data} onBack={onBack} />;
}

type Draft = Awaited<ReturnType<typeof client.series.draft>>;

function ReviewForm({ language, draft, onBack }: { language: Language; draft: Draft; onBack: () => void }) {
  const navigate = useNavigate();
  const [displayTitle, setDisplayTitle] = useState(draft.displayTitle);
  const [searchTerms, setSearchTerms] = useState(draft.searchTerms);
  const [aliases, setAliases] = useState(draft.aliases);
  const [authors, setAuthors] = useState(draft.authors);
  // Untouched, the count is left out so the server uses MangaBaka's (or the Manga-News row's).
  const [count, setCount] = useState<number | string>(draft.volumeCount ?? "");
  const [countTouched, setCountTouched] = useState(false);
  // "" = a new folder named after the display title; otherwise an existing folder.
  const [folder, setFolder] = useState(draft.folderFrom === "matching_name" ? draft.folderPath : "");
  const [mangaNewsId, setMangaNewsId] = useState<number | undefined>();

  const folders = useQuery(orpc.languages.folders.queryOptions({ input: { id: language.id }, throwOnError: false }));
  const create = useMutation(
    orpc.series.create.mutationOptions({
      onSuccess: (created) => navigate({ to: "/series/$id", params: { id: created.id } }),
    }),
  );

  const folderOptions = [
    { value: "", label: `New folder named after the display title, in ${language.rootFolder}` },
    ...(folders.data ?? [])
      .filter((f) => f.seriesId === null)
      .map((f) => ({ value: f.path, label: f.path === draft.folderPath && draft.folderFrom === "matching_name" ? `${f.name} (suggested)` : f.name })),
  ];
  const suggestedMissing = draft.folderFrom === "matching_name" && folders.data && !folders.data.some((f) => f.path === draft.folderPath);

  const submit = () =>
    create.mutate({
      languageId: language.id,
      mangabakaId: draft.mangabakaId,
      displayTitle,
      searchTerms,
      aliases,
      authors,
      ...(countTouched && { volumeCount: typeof count === "number" ? count : null }),
      ...(folder && { folderPath: folder }),
      ...(mangaNewsId !== undefined && { mangaNewsSeriesId: mangaNewsId }),
    });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack>
        <Group wrap="nowrap" align="flex-start">
          <Image src={draft.coverUrl} w={72} h={108} fit="cover" fallbackSrc="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" />
          <Stack gap={2}>
            <Text fw={600} size="lg">
              {draft.title}
            </Text>
            <Text size="sm" c="dimmed">
              {[draft.nativeTitle, draft.year, draft.type, draft.status].filter(Boolean).join(" · ")}
            </Text>
            <div>
              <Anchor component="button" type="button" size="sm" onClick={onBack}>
                Pick another series
              </Anchor>
            </div>
          </Stack>
        </Group>

        {draft.existingSeriesId !== null && (
          <Alert color="orange" variant="light">
            Already added in {language.name}.{" "}
            <Anchor
              component="button"
              type="button"
              onClick={() => navigate({ to: "/series/$id", params: { id: draft.existingSeriesId! } })}
            >
              Open it
            </Anchor>
          </Alert>
        )}

        <TextInput
          label="Display title"
          description="Names the folder and the volume files."
          required
          value={displayTitle}
          onChange={(e) => setDisplayTitle(e.currentTarget.value)}
        />
        <TagsInput
          label="Search terms"
          description="Each one is a Prowlarr query, and is also accepted when matching results."
          required
          value={searchTerms}
          onChange={setSearchTerms}
        />
        <TagsInput
          label="Aliases"
          description="Accepted when matching results, never searched."
          value={aliases}
          onChange={setAliases}
        />
        <TagsInput
          label="Authors"
          description="Lets releases with the author's name in front match."
          value={authors}
          onChange={setAuthors}
        />

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
          {draft.volumeCountFrom && !countTouched && (
            <Text size="xs" c="dimmed" mt={4}>
              From MangaBaka's {draft.volumeCountFrom === "collection" ? "collection" : "final volume"}.
            </Text>
          )}
          {draft.volumeCountOptions.length > 1 && (
            <Group gap="xs" mt={4}>
              <Text size="xs" c="dimmed">
                Other editions:
              </Text>
              {draft.volumeCountOptions.map((option, i) => (
                <Badge
                  key={i}
                  component="button"
                  type="button"
                  size="sm"
                  variant="light"
                  style={{ cursor: "pointer" }}
                  onClick={() => {
                    setCount(option.volumeCount);
                    setCountTouched(true);
                  }}
                >
                  {[option.edition ?? option.medium, option.publisher].filter(Boolean).join(", ") || "Edition"}: {option.volumeCount}
                </Badge>
              ))}
            </Group>
          )}
        </div>

        <div>
          <Select
            label="Folder"
            allowDeselect={false}
            data={folderOptions}
            value={folder}
            onChange={(value) => setFolder(value ?? "")}
            searchable
          />
          <Text size="xs" c="dimmed" mt={4}>
            {folder === ""
              ? draft.folderFrom === "display_title" && draft.folderExists
                ? `${draft.folderPath} already exists and will be used.`
                : "Created by the first import."
              : "An existing folder: its volumes are found by the first scan."}
            {draft.folderSeriesId !== null && folder === "" && " Another series already uses the default folder."}
            {suggestedMissing && " The suggested folder is no longer in the root."}
          </Text>
        </div>

        {language.useMangaNewsDataset && <MangaNewsPicker value={mangaNewsId} onChange={setMangaNewsId} initialQuery={draft.title} />}

        {create.error && (
          <Alert color="red" variant="light">
            {create.error.message}
          </Alert>
        )}
        <Group>
          <Button type="submit" loading={create.isPending} disabled={draft.existingSeriesId !== null || searchTerms.length === 0 || !displayTitle.trim()}>
            Add series
          </Button>
          <Button variant="subtle" onClick={onBack}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
