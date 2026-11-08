import { PasswordInput, TextInput } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { minPasswordLength } from "@mangarr/server/password-rules";
import { useState } from "react";
import { authStatusQuery, orpc, queryClient } from "../api";
import { AuthForm } from "../components/AuthForm";

export function SetupPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const setup = useMutation(
    orpc.auth.setup.mutationOptions({
      onSuccess: async ({ username }) => {
        queryClient.setQueryData(authStatusQuery.queryKey, { setupRequired: false, username });
        await navigate({ to: "/" });
      },
    }),
  );

  const tooShort = password.length < minPasswordLength;
  const mismatch = confirm !== password;

  return (
    <AuthForm
      title="Welcome to mangarr"
      description="Create the account you'll sign in with. Scripts use the API key from Settings instead."
      submitLabel="Create account"
      pending={setup.isPending}
      error={setup.error?.message}
      onSubmit={() => {
        setSubmitted(true);
        if (!tooShort && !mismatch) setup.mutate({ username, password });
      }}
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
        description={`At least ${minPasswordLength} characters`}
        autoComplete="new-password"
        required
        value={password}
        onChange={(event) => setPassword(event.currentTarget.value)}
        error={submitted && tooShort ? `Use at least ${minPasswordLength} characters` : undefined}
      />
      <PasswordInput
        label="Confirm password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(event) => setConfirm(event.currentTarget.value)}
        error={submitted && mismatch ? "The passwords don't match" : undefined}
      />
    </AuthForm>
  );
}
