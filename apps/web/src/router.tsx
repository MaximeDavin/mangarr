// The route tree (spec §9), code-based: no route-generation plugin.

import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { authStatusQuery, queryClient } from "./api";
import { Layout } from "./components/Layout";
import { RouteError, RoutePending } from "./components/RouteStatus";
import { AboutPage } from "./pages/About";
import { ActivityPage } from "./pages/Activity";
import { AddSeriesPage } from "./pages/AddSeries";
import { LoginPage } from "./pages/Login";
import { NotFoundPage } from "./pages/NotFound";
import { SeriesDetailPage } from "./pages/SeriesDetail";
import { SeriesListPage } from "./pages/SeriesList";
import {
  ConnectSettingsPage,
  DownloadClientsSettingsPage,
  GeneralSettingsPage,
  IndexersSettingsPage,
  LanguagesSettingsPage,
  MetadataSettingsPage,
  SettingsIndexPage,
} from "./pages/Settings";
import { SetupPage } from "./pages/Setup";

const authStatus = () => queryClient.ensureQueryData(authStatusQuery);

const rootRoute = createRootRoute({ notFoundComponent: NotFoundPage });

/** Full-page forms, outside the navigation (spec §9). */
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async () => {
    if (!(await authStatus()).setupRequired) throw redirect({ to: "/login" });
  },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  /** Where to go once signed in. */
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async () => {
    const status = await authStatus();
    if (status.setupRequired) throw redirect({ to: "/setup" });
    if (status.username) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

/** Every other page: the app's shell, for a signed-in user only. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ location }) => {
    const status = await authStatus();
    if (status.setupRequired) throw redirect({ to: "/setup" });
    if (!status.username) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: Layout,
});

const seriesListRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  /** `?language=fr` filters the grid by language code. */
  validateSearch: z.object({ language: z.string().optional() }),
  component: SeriesListPage,
});

const addSeriesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/series/add",
  component: AddSeriesPage,
});

const seriesDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/series/$id",
  params: {
    parse: ({ id }) => ({ id: z.coerce.number().int().positive().parse(id) }),
    stringify: ({ id }) => ({ id: String(id) }),
  },
  component: SeriesDetailPage,
});

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/activity",
  component: ActivityPage,
});

/** Settings, one page per category as in Sonarr; `/settings` itself lists the categories. */
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
});

const settingsPage = <TPath extends string>(path: TPath, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => settingsRoute, path, component });

const settingsPages = [
  settingsPage("/", SettingsIndexPage),
  settingsPage("/languages", LanguagesSettingsPage),
  settingsPage("/indexers", IndexersSettingsPage),
  settingsPage("/download-clients", DownloadClientsSettingsPage),
  settingsPage("/connect", ConnectSettingsPage),
  settingsPage("/metadata", MetadataSettingsPage),
  settingsPage("/general", GeneralSettingsPage),
] as const;

const aboutRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/about",
  component: AboutPage,
});

/** Any other address: a not-found page inside the app, behind the same sign-in check. */
const notFoundRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "$",
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    seriesListRoute,
    addSeriesRoute,
    seriesDetailRoute,
    activityRoute,
    settingsRoute.addChildren(settingsPages),
    aboutRoute,
    notFoundRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  // Shown inside the layout: while a page's `useSuspenseQuery` waits, and when a query fails.
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
