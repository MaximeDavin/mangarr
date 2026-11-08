// What a page shows while its data loads or after it fails to (set as router defaults).

import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";

export function RoutePending() {
  return (
    <Center py="xl">
      <Loader />
    </Center>
  );
}

/** A failed query or render, with the server's message (oRPC errors carry it). */
export function RouteError({ error, reset }: ErrorComponentProps) {
  // Let the failed queries fetch again when the page mounts next, instead of rethrowing.
  const queryErrorBoundary = useQueryErrorResetBoundary();
  useEffect(() => queryErrorBoundary.reset(), [queryErrorBoundary]);

  return (
    <Alert color="red" title="Something went wrong" variant="light">
      <Stack align="flex-start" gap="xs">
        {error instanceof Error ? error.message : String(error)}
        <Button size="xs" variant="light" color="red" onClick={reset}>
          Try again
        </Button>
      </Stack>
    </Alert>
  );
}
