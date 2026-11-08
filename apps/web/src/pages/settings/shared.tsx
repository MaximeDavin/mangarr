// Pieces shared by the Settings sections.

import { Alert, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import type { client } from "../../api";
import { orpc } from "../../api";

export type Settings = Awaited<ReturnType<typeof client.settings.get>>;

/** Saves some settings, then refreshes everything that reads them (indexer and library pickers too). */
export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.settings.update.mutationOptions({
      onSuccess: () => {
        notifications.show({ message: "Settings saved", color: "green" });
        for (const key of [orpc.settings.key(), orpc.prowlarr.key(), orpc.komga.key()]) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      },
    }),
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card withBorder padding="lg">
      <Stack>
        <div>
          <Title order={3} size="h4">
            {title}
          </Title>
          {description && (
            <Text size="sm" c="dimmed" mt={2}>
              {description}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Card>
  );
}

/** A section's form: Enter submits, `extra` sits beside the Save button (a connection test, say). */
export function SectionForm({
  onSubmit,
  pending,
  error,
  extra,
  saveLabel = "Save",
  children,
}: {
  onSubmit: () => void;
  pending: boolean;
  error?: string;
  extra?: ReactNode;
  saveLabel?: string;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form onSubmit={submit}>
      <Stack>
        {children}
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group>
          <Button type="submit" loading={pending}>
            {saveLabel}
          </Button>
          {extra}
        </Group>
      </Stack>
    </form>
  );
}

/** The outcome of a connection test: green when it worked, red with the server's message when not. */
export function TestResult({ ok, error }: { ok?: ReactNode; error?: Error | null }) {
  if (error) {
    return (
      <Alert color="red" variant="light">
        {error.message}
      </Alert>
    );
  }
  if (ok) {
    return (
      <Alert color="green" variant="light">
        {ok}
      </Alert>
    );
  }
  return null;
}

export const secretPlaceholder = (isSet: boolean) => (isSet ? "Saved: leave empty to keep" : "");
