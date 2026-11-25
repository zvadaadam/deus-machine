import { UnsecuredJWT } from "jose";
import { expect, it } from "vitest";
import { parse, runCommand } from "../../e2e/remote-access/commands.mjs";

it("hands an outside client Alice's existing web session and its token expiry", async () => {
  const expiresAt = "2027-01-03T04:05:06Z";
  const aliceWeb = new UnsecuredJWT()
    .setSubject("user_alice")
    .setExpirationTime(Date.parse(expiresAt) / 1000)
    .encode();
  const lab = { sessions: { aliceWeb } };

  expect(await runCommand(lab, parse(["client-session"]))).toEqual({
    accountId: "user_alice",
    sessionToken: aliceWeb,
    expiresAt,
  });
});
