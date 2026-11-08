import { Anchor, List, Stack, Text, Title } from "@mantine/core";

export function AboutPage() {
  return (
    <Stack maw={640}>
      <Title order={2}>About</Title>
      <Text>mangarr {__MANGARR_VERSION__}</Text>

      <Title order={4}>Credits</Title>
      <List spacing="xs">
        <List.Item>
          Series metadata from{" "}
          <Anchor href="https://mangabaka.org" target="_blank" rel="noreferrer">
            MangaBaka
          </Anchor>
          , for personal, non-commercial use.
        </List.Item>
        <List.Item>
          French publishers and volume counts from the Manga-News dataset on{" "}
          <Anchor href="https://www.data.gouv.fr" target="_blank" rel="noreferrer">
            data.gouv.fr
          </Anchor>
          , under the{" "}
          <Anchor href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noreferrer">
            ODbL
          </Anchor>
          .
        </List.Item>
      </List>
    </Stack>
  );
}
