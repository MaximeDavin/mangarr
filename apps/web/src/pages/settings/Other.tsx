// Manga-News dataset, the mangarr API key, and the password (spec §9.6).

import { Button, CopyButton, Group, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { orpc } from "../../api";
import { Section, SectionForm, type Settings, TestResult, useSaveSettings } from "./shared";

export function MangaNewsSection({ settings }: { settings: Settings }) {
  const [url, setUrl] = useState(settings.mangaNewsCsvUrl);
  const queryClient = useQueryClient();
  const status = useQuery(orpc.mangaNews.status.queryOptions());
  const save = useSaveSettings();
  const refresh = useMutation(
    orpc.mangaNews.refresh.mutationOptions({ onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.mangaNews.key() }) }),
  );
  const r = refresh.data;

  return (
    <Section
      title="Manga-News dataset"
      description="A third-party CSV of French series with their publisher and number of volumes. Refreshed by hand, never on a schedule."
    >
      <SectionForm
        pending={save.isPending}
        error={save.error?.message}
        onSubmit={() => save.mutate({ mangaNewsCsvUrl: url })}
        extra={
          <Button variant="light" loading={refresh.isPending} onClick={() => refresh.mutate({})}>
            Refresh dataset
          </Button>
        }
      >
        <TextInput label="CSV URL" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        <Text size="sm" c="dimmed">
          {status.data
            ? status.data.rowCount === 0
              ? "Not loaded yet."
              : `${status.data.rowCount} series, loaded ${status.data.importedAt?.toLocaleString() ?? "at an unknown time"}.`
            : "Loading…"}
        </Text>
        <TestResult
          ok={
            r &&
            `Refreshed: ${r.rowCount} series (${r.added} new, ${r.removed} removed). ${r.seriesUpdated} series updated, ${r.seriesUnlinked} unlinked.`
          }
          error={refresh.error}
        />
      </SectionForm>
      {url !== settings.mangaNewsCsvUrl && (
        <Text size="xs" c="dimmed" mt={-8}>
          Save the URL before refreshing: the refresh uses the saved one.
        </Text>
      )}
    </Section>
  );
}

export function ApiKeySection({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const regenerate = useMutation(
    orpc.settings.regenerateApiKey.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.settings.key() }),
    }),
  );

  return (
    <Section
      title="API key"
      description={
        <>
          For scripts and dashboards: send it as the <code>X-Api-Key</code> header. The REST API is documented at <code>/api/v1/openapi.json</code>.
        </>
      }
    >
      <Group align="flex-end" wrap="nowrap">
        <PasswordInput label="mangarr API key" readOnly value={settings.apiKey} style={{ flex: 1 }} />
        <CopyButton value={settings.apiKey}>
          {({ copied, copy }) => (
            <Button variant="light" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
        <Button
          variant="light"
          color="red"
          loading={regenerate.isPending}
          onClick={() => window.confirm("Replace the API key? The old one stops working immediately.") && regenerate.mutate({})}
        >
          Regenerate
        </Button>
      </Group>
      <TestResult error={regenerate.error} />
    </Section>
  );
}

export function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation(
    orpc.auth.changePassword.mutationOptions({
      onSuccess: () => {
        notifications.show({ message: "Password changed. Other sessions were signed out.", color: "green" });
        setCurrent("");
        setNext("");
        setConfirm("");
      },
    }),
  );
  const mismatch = confirm !== "" && confirm !== next;

  return (
    <Section title="Password" description="Changing it signs out every other session.">
      <SectionForm
        saveLabel="Change password"
        pending={change.isPending}
        error={mismatch ? "The two new passwords differ" : change.error?.message}
        onSubmit={() => !mismatch && change.mutate({ currentPassword: current, newPassword: next })}
      >
        <Stack gap="sm">
          <PasswordInput label="Current password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.currentTarget.value)} />
          <PasswordInput label="New password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.currentTarget.value)} />
          <PasswordInput label="Repeat the new password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
        </Stack>
      </SectionForm>
    </Section>
  );
}
