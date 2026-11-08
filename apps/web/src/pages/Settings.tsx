import { SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { orpc } from "../api";
import { CardLink } from "../components/links";
import { type SettingsPath, settingsCategories } from "./settings/categories";
import { LanguagesSection } from "./settings/Languages";
import { ApiKeySection, MangaNewsSection, PasswordSection } from "./settings/Other";
import { KomgaSection, ProwlarrSection, QBittorrentSection } from "./settings/Services";

/** Spec §9.6, split into categories. Each section keeps its own form state and saves on its own. */

/** `/settings`: one card per category. */
export function SettingsIndexPage() {
  return (
    <Stack maw={760}>
      <Title order={2}>Settings</Title>
      <SimpleGrid cols={{ base: 1, xs: 2 }}>
        {settingsCategories.map((category) => (
          <CardLink key={category.to} to={category.to} withBorder padding="md">
            <Text fw={500}>{category.label}</Text>
            <Text size="sm" c="dimmed" mt={2}>
              {category.description}
            </Text>
          </CardLink>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

/** A category page: its title and description, then its sections. */
function SettingsCategory({ path, children }: { path: SettingsPath; children: ReactNode }) {
  const category = settingsCategories.find((c) => c.to === path)!;
  return (
    <Stack maw={760}>
      <div>
        <Title order={2}>{category.label}</Title>
        <Text c="dimmed">{category.description}</Text>
      </div>
      {children}
    </Stack>
  );
}

const useSettings = () => useSuspenseQuery(orpc.settings.get.queryOptions()).data;

export function LanguagesSettingsPage() {
  return (
    <SettingsCategory path="/settings/languages">
      <LanguagesSection />
    </SettingsCategory>
  );
}

export function IndexersSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsCategory path="/settings/indexers">
      <ProwlarrSection settings={settings} />
    </SettingsCategory>
  );
}

export function DownloadClientsSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsCategory path="/settings/download-clients">
      <QBittorrentSection settings={settings} />
    </SettingsCategory>
  );
}

export function ConnectSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsCategory path="/settings/connect">
      <KomgaSection settings={settings} />
    </SettingsCategory>
  );
}

export function MetadataSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsCategory path="/settings/metadata">
      <MangaNewsSection settings={settings} />
    </SettingsCategory>
  );
}

export function GeneralSettingsPage() {
  const settings = useSettings();
  return (
    <SettingsCategory path="/settings/general">
      <ApiKeySection settings={settings} />
      <PasswordSection />
    </SettingsCategory>
  );
}
