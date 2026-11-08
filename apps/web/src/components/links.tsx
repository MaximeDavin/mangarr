// Mantine components that navigate with TanStack Router: typed `to`/`params`/`search`,
// preloading on hover, and a real <a href> so middle-click works.

import {
  type AnchorProps,
  Button,
  type ButtonProps,
  Card,
  type CardProps,
  Anchor as MantineAnchor,
  NavLink,
  type NavLinkProps,
} from "@mantine/core";
import { createLink } from "@tanstack/react-router";
import type { ComponentPropsWithRef } from "react";

type Anchor = ComponentPropsWithRef<"a">;

export const AnchorLink = createLink((props: AnchorProps & Anchor) => <MantineAnchor component="a" {...props} />);

export const ButtonLink = createLink((props: ButtonProps & Anchor) => <Button component="a" {...props} />);

export const CardLink = createLink((props: CardProps & Anchor) => <Card component="a" {...props} />);

/** Highlighted while its route is the current one (TanStack sets `data-status="active"`). */
export const NavRouterLink = createLink((props: Omit<NavLinkProps, "active"> & Anchor & { "data-status"?: string }) => (
  <NavLink component="a" active={props["data-status"] === "active"} {...props} />
));
