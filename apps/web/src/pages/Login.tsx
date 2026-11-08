import { PasswordInput, TextInput } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { authStatusQuery, orpc, queryClient, safeRedirect } from "../api";
import { AuthForm } from "../components/AuthForm";

const route = getRouteApi("/login");

export function LoginPage() {
  const router = useRouter();
  const { redirect } = route.useSearch();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation(
    orpc.auth.login.mutationOptions({
      meta: { signIn: true },
      onSuccess: ({ username }) => {
        queryClient.setQueryData(authStatusQuery.queryKey, { setupRequired: false, username });
        router.history.push(safeRedirect(redirect));
      },
    }),
  );

  return (
    <AuthForm
      title="Sign in to mangarr"
      submitLabel="Sign in"
      pending={login.isPending}
      error={login.error?.message}
      onSubmit={() => login.mutate({ username, password })}
    >
      <TextInput
        label="Username"
        autoComplete="username"
        required
        autoFocus
        value={username}
        onChange={(event) => setUsername(event.currentTarget.value)}
      />
      <PasswordInput
        label="Password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.currentTarget.value)}
      />
    </AuthForm>
  );
}
