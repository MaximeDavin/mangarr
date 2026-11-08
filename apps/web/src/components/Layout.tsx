import { AppShell, Burger, Button, Group, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { Fragment } from "react";
import { authStatusQuery, orpc, queryClient } from "../api";
import { settingsCategories } from "../pages/settings/categories";
import { NavRouterLink } from "./links";

const nav = [
  { to: "/", label: "Series" },
  { to: "/series/add", label: "Add series" },
  { to: "/activity", label: "Activity" },
  { to: "/settings", label: "Settings" },
  { to: "/about", label: "About" },
] as const;

function SignOut() {
  const navigate = useNavigate();
  const { data } = useQuery(authStatusQuery);
  const signOut = useMutation(
    orpc.auth.logout.mutationOptions({
      onSuccess: async () => {
        // Nothing from the session stays on screen or in the cache.
        queryClient.clear();
        await navigate({ to: "/login" });
      },
      onError: (error) => notifications.show({ color: "red", title: "Could not sign out", message: error.message }),
    }),
  );

  return (
    <Group gap="sm">
      {data?.username && (
        <Text size="sm" c="dimmed" visibleFrom="xs">
          {data.username}
        </Text>
      )}
      <Button variant="subtle" size="compact-sm" loading={signOut.isPending} onClick={() => signOut.mutate({})}>
        Sign out
      </Button>
    </Group>
  );
}

/** The app's shell around every signed-in page. */
export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Title order={3}>mangarr</Title>
          </Group>
          <SignOut />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        {nav.map((item) => (
          <Fragment key={item.to}>
            <NavRouterLink
              to={item.to}
              label={item.label}
              // Exact, so "/" isn't active everywhere; `?language=fr` on the series list is still the series list.
              activeOptions={{ exact: true, includeSearch: false }}
              onClick={close}
            />
            {/* As in Sonarr: the categories show under Settings while you're in it. */}
            {item.to === "/settings" && inSettings && (
              <Stack gap={0} pl="md">
                {settingsCategories.map((category) => (
                  <NavRouterLink key={category.to} to={category.to} label={category.label} onClick={close} />
                ))}
              </Stack>
            )}
          </Fragment>
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
