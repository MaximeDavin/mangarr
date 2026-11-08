// The frame shared by the Setup and Login pages: a centred card, outside the app's navigation.

import { Alert, Button, Center, Paper, Stack, Text, Title } from "@mantine/core";
import type { FormEvent, ReactNode } from "react";

export function AuthForm({
  title,
  description,
  submitLabel,
  pending,
  error,
  onSubmit,
  children,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  pending: boolean;
  error?: string;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={380}>
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={2}>{title}</Title>
              {description && (
                <Text size="sm" c="dimmed" mt={4}>
                  {description}
                </Text>
              )}
            </div>
            {children}
            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}
            <Button type="submit" loading={pending} fullWidth>
              {submitLabel}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
