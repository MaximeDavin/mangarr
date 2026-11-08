import { Stack, Text, Title } from "@mantine/core";
import { ButtonLink } from "../components/links";

export function NotFoundPage() {
  return (
    <Stack align="flex-start">
      <Title order={2}>Page not found</Title>
      <Text c="dimmed">There is nothing at this address.</Text>
      <ButtonLink to="/" variant="light">
        Back to series
      </ButtonLink>
    </Stack>
  );
}
