// Languages (spec §4.1): indexers, root folder, Komga library, and the warnings from saving one.

import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type client, orpc } from "../../api";
import { Section, SectionForm } from "./shared";

type Language = Awaited<ReturnType<typeof client.languages.list>>[number];

export function LanguagesSection() {
  const languages = useQuery(orpc.languages.list.queryOptions());
  // Editing: a language, "new", or nothing.
  const [editing, setEditing] = useState<Language | "new" | null>(null);
  const queryClient = useQueryClient();
  const remove = useMutation(
    orpc.languages.delete.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.languages.key() }),
      onError: (error) => notifications.show({ title: "Could not delete", message: error.message, color: "red" }),
    }),
  );

  return (
    <Section
      title="Languages"
      description="Each language sets which indexers are searched, where volumes are filed and which Komga library is rescanned."
    >
      <Stack>
        {languages.data?.length === 0 && <Text c="dimmed">No language yet.</Text>}
        {languages.data?.map((language) => (
          <Card key={language.id} withBorder padding="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <Stack gap={2}>
                <Group gap="xs">
                  <Text fw={500}>{language.name}</Text>
                  <Badge size="xs" variant="light">
                    {language.code}
                  </Badge>
                </Group>
                <Text size="sm" c="dimmed">
                  {language.rootFolder} · {language.prowlarrIndexerIds.length} indexer(s)
                  {language.komgaLibraryId ? " · Komga library set" : " · no Komga scan"}
                </Text>
              </Stack>
              <Group gap="xs" wrap="nowrap">
                <Button size="xs" variant="light" onClick={() => setEditing(language)}>
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  loading={remove.isPending && remove.variables?.id === language.id}
                  onClick={() =>
                    window.confirm(`Delete ${language.name}? Only works while it has no series.`) &&
                    remove.mutate({ id: language.id })
                  }
                >
                  Delete
                </Button>
              </Group>
            </Group>
            {language.komgaScanError && (
              <Alert color="orange" variant="light" mt="xs" title="Last Komga scan failed">
                {language.komgaScanError}
                {language.komgaScanErrorAt && ` (${language.komgaScanErrorAt.toLocaleString()})`}
              </Alert>
            )}
          </Card>
        ))}
        <div>
          <Button variant="light" onClick={() => setEditing("new")}>
            Add language
          </Button>
        </div>
      </Stack>

      <Modal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add language" : "Edit language"}
        size="lg"
      >
        {editing && <LanguageForm language={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </Section>
  );
}

function LanguageForm({ language, onDone }: { language?: Language; onDone: () => void }) {
  const [name, setName] = useState(language?.name ?? "");
  const [code, setCode] = useState(language?.code ?? "");
  const [rootFolder, setRootFolder] = useState(language?.rootFolder ?? "");
  const [indexerIds, setIndexerIds] = useState((language?.prowlarrIndexerIds ?? []).map(String));
  const [categories, setCategories] = useState((language?.prowlarrCategories ?? []).map(String));
  const [libraryId, setLibraryId] = useState<string | null>(language?.komgaLibraryId ?? null);
  const [useMangaNews, setUseMangaNews] = useState(language?.useMangaNewsDataset ?? false);
  const queryClient = useQueryClient();

  // The pickers need Prowlarr and Komga to be set up; without them the form says so instead of failing the page.
  const indexers = useQuery(orpc.prowlarr.indexers.queryOptions({ throwOnError: false }));
  const libraries = useQuery(orpc.komga.libraries.queryOptions({ throwOnError: false }));

  const torrentIndexers = (indexers.data ?? []).filter((i) => i.protocol !== "usenet");
  const indexerOptions = torrentIndexers.map((i) => ({
    value: String(i.id),
    label: i.enabled ? i.name : `${i.name} (disabled)`,
  }));
  // Categories offered by the chosen indexers, plus any already saved, so a saved id never loses its label.
  const categoryLabels = new Map<string, string>();
  for (const indexer of torrentIndexers) {
    if (indexerIds.includes(String(indexer.id)))
      for (const c of indexer.categories) categoryLabels.set(String(c.id), `${c.name} (${c.id})`);
  }
  for (const id of categories) if (!categoryLabels.has(id)) categoryLabels.set(id, id);
  const categoryOptions = [...categoryLabels].map(([value, label]) => ({ value, label }));

  const onSuccess = (saved: { warnings: string[] }) => {
    void queryClient.invalidateQueries({ queryKey: orpc.languages.key() });
    notifications.show({ message: "Language saved", color: "green" });
    for (const warning of saved.warnings) {
      notifications.show({ title: "Warning", message: warning, color: "orange", autoClose: false });
    }
    onDone();
  };
  const create = useMutation(orpc.languages.create.mutationOptions({ onSuccess }));
  const update = useMutation(orpc.languages.update.mutationOptions({ onSuccess }));
  const saving = language ? update : create;

  const submit = () => {
    const values = {
      name,
      code,
      rootFolder,
      prowlarrIndexerIds: indexerIds.map(Number),
      prowlarrCategories: categories.map(Number),
      komgaLibraryId: libraryId,
      useMangaNewsDataset: useMangaNews,
    };
    if (language) update.mutate({ id: language.id, ...values });
    else create.mutate(values);
  };

  return (
    <SectionForm onSubmit={submit} pending={saving.isPending} error={saving.error?.message}>
      <Group grow align="flex-start">
        <TextInput
          label="Name"
          placeholder="French"
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label="Code"
          placeholder="fr"
          required
          description="en, fr, pt-br…"
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
      </Group>
      <TextInput
        label="Root folder"
        placeholder="/data/media/manga/fr"
        required
        description="The path as seen by mangarr, qBittorrent and Komga alike."
        value={rootFolder}
        onChange={(e) => setRootFolder(e.currentTarget.value)}
      />
      <MultiSelect
        label="Prowlarr indexers"
        placeholder={indexerOptions.length ? "Pick indexers" : "No indexers"}
        data={indexerOptions}
        value={indexerIds}
        onChange={setIndexerIds}
        searchable
        error={indexers.error ? `Could not load indexers: ${indexers.error.message}` : undefined}
      />
      <MultiSelect
        label="Categories"
        description="Optional. Empty searches all categories."
        data={categoryOptions}
        value={categories}
        onChange={setCategories}
        searchable
        disabled={indexerIds.length === 0 && categories.length === 0}
      />
      <Select
        label="Komga library"
        description="Optional. Without one, no scan is triggered."
        placeholder="None"
        clearable
        data={(libraries.data ?? []).map((l) => ({ value: l.id, label: `${l.name} (${l.root})` }))}
        value={libraryId}
        onChange={setLibraryId}
        error={libraries.error ? `Could not load libraries: ${libraries.error.message}` : undefined}
      />
      <Switch
        label="Offer the Manga-News dataset"
        description="Lets you link a Manga-News row when adding a series: its publisher and volume count."
        checked={useMangaNews}
        onChange={(e) => setUseMangaNews(e.currentTarget.checked)}
      />
    </SectionForm>
  );
}
