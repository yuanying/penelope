// The house's name is its residents' to see, so nothing of the house is shown here.
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";

import { words } from "./words.ts";

export function Login() {
  return (
    <Center minHeight="100dvh" padding={6}>
      <main className="login">
        <img src="/icon.svg" width={72} height={72} alt="" />
        <h1>{words.loginTitle}</h1>
        <Button label={words.login} variant="primary" size="lg" href="/auth/github/start" />
        <p className="muted">{words.loginNote}</p>
      </main>
    </Center>
  );
}
