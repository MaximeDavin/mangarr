// Prowlarr, qBittorrent and Komga: each a URL, credentials and a connection test (spec §9.6).

import { Button, NumberInput, PasswordInput, Text, TextInput } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { orpc } from "../../api";
import { Section, SectionForm, secretPlaceholder, type Settings, TestResult, useSaveSettings } from "./shared";

export function ProwlarrSection({ settings }: { settings: Settings }) {
  const [url, setUrl] = useState(settings.prowlarrUrl);
  const [apiKey, setApiKey] = useState("");
  const save = useSaveSettings();
  const test = useMutation(orpc.prowlarr.test.mutationOptions());

  return (
    <Section title="Prowlarr" description="Used to search the indexers you pick for each language.">
      <SectionForm
        pending={save.isPending}
        error={save.error?.message}
        onSubmit={() => {
          save.mutate({ prowlarrUrl: url, ...(apiKey && { prowlarrApiKey: apiKey }) });
          setApiKey("");
        }}
        extra={
          <Button variant="light" loading={test.isPending} onClick={() => test.mutate({ url, ...(apiKey && { apiKey }) })}>
            Test connection
          </Button>
        }
      >
        <TextInput label="URL" placeholder="http://prowlarr:9696" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        <PasswordInput
          label="API key"
          placeholder={secretPlaceholder(settings.prowlarrApiKeySet)}
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />
        <TestResult ok={test.data && `Connected to Prowlarr ${test.data.version}`} error={test.error} />
      </SectionForm>
    </Section>
  );
}

export function QBittorrentSection({ settings }: { settings: Settings }) {
  const [url, setUrl] = useState(settings.qbittorrentUrl);
  const [username, setUsername] = useState(settings.qbittorrentUsername);
  const [password, setPassword] = useState("");
  const [category, setCategory] = useState(settings.qbittorrentCategory);
  const [pollInterval, setPollInterval] = useState<number | string>(settings.pollIntervalSeconds);
  const save = useSaveSettings();
  const test = useMutation(orpc.qbittorrent.test.mutationOptions());

  return (
    <Section title="qBittorrent" description="The download client. mangarr never deletes or pauses torrents.">
      <SectionForm
        pending={save.isPending}
        error={save.error?.message}
        onSubmit={() => {
          save.mutate({
            qbittorrentUrl: url,
            qbittorrentUsername: username,
            ...(password && { qbittorrentPassword: password }),
            qbittorrentCategory: category,
            ...(typeof pollInterval === "number" && { pollIntervalSeconds: pollInterval }),
          });
          setPassword("");
        }}
        extra={
          <Button variant="light" loading={test.isPending} onClick={() => test.mutate({ url, username, ...(password && { password }) })}>
            Test connection
          </Button>
        }
      >
        <TextInput label="URL" placeholder="http://qbittorrent:8080" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        <TextInput label="Username" autoComplete="off" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <PasswordInput
          label="Password"
          placeholder={secretPlaceholder(settings.qbittorrentPasswordSet)}
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed" mt={-8}>
          Leave the username and password empty if qBittorrent skips authentication for mangarr's network.
        </Text>
        <TextInput label="Category" required value={category} onChange={(e) => setCategory(e.currentTarget.value)} />
        <NumberInput label="Poll interval (seconds)" min={5} max={3600} allowDecimal={false} value={pollInterval} onChange={setPollInterval} />
        <TestResult ok={test.data && `Connected to qBittorrent ${test.data.version}`} error={test.error} />
      </SectionForm>
    </Section>
  );
}

export function KomgaSection({ settings }: { settings: Settings }) {
  const [url, setUrl] = useState(settings.komgaUrl);
  const [apiKey, setApiKey] = useState("");
  const save = useSaveSettings();
  const test = useMutation(orpc.komga.test.mutationOptions());
  const result = test.data;

  return (
    <Section
      title="Komga"
      description="After imports, mangarr asks Komga to rescan the language's library. The key's user must be an admin."
    >
      <SectionForm
        pending={save.isPending}
        error={save.error?.message}
        onSubmit={() => {
          save.mutate({ komgaUrl: url, ...(apiKey && { komgaApiKey: apiKey }) });
          setApiKey("");
        }}
        extra={
          <Button variant="light" loading={test.isPending} onClick={() => test.mutate({ url, ...(apiKey && { apiKey }) })}>
            Test connection
          </Button>
        }
      >
        <TextInput label="URL" placeholder="http://komga:25600" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
        <PasswordInput
          label="API key"
          placeholder={secretPlaceholder(settings.komgaApiKeySet)}
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />
        {result && !result.canScan ? (
          <TestResult
            error={new Error(`Connected (${result.libraries.length} libraries), but this key's user isn't an admin, so scans will be refused.`)}
          />
        ) : (
          <TestResult ok={result && `Connected: ${result.libraries.length} libraries, and the key can scan.`} error={test.error} />
        )}
      </SectionForm>
    </Section>
  );
}
