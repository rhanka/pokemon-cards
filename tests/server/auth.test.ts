// @vitest-environment node

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { OidcAuthenticator } from "../../server/auth.js";

describe("OIDC authentication", () => {
  it("should reject insecure remote issuer and explicit JWKS endpoints", () => {
    expect(
      () =>
        new OidcAuthenticator({
          issuer: "http://auth.example.test",
          audience: "cardscope-api",
        }),
    ).toThrow("OIDC issuer must use HTTPS");
    expect(
      () =>
        new OidcAuthenticator({
          issuer: "https://auth.example.test",
          audience: "cardscope-api",
          jwksUri: "http://keys.example.test/jwks.json",
        }),
    ).toThrow("OIDC JWKS URI must use HTTPS");
    expect(
      () =>
        new OidcAuthenticator({
          issuer: "http://localhost:8080",
          audience: "cardscope-api",
          jwksUri: "http://127.0.0.1:8080/jwks.json",
        }),
    ).not.toThrow();
  });

  it("should discover the issuer JWKS URI and verify its audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    Object.assign(publicJwk, {
      kid: "test-signing-key",
      alg: "ES256",
      use: "sig",
    });
    const token = await new SignJWT({ email: "collector@example.test" })
      .setProtectedHeader({ alg: "ES256", kid: "test-signing-key" })
      .setIssuer("https://auth.example.test")
      .setAudience("cardscope-api")
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "https://auth.example.test",
            jwks_uri: "https://keys.example.test/jwks.json",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://keys.example.test/jwks.json") {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const authenticator = new OidcAuthenticator({
      issuer: "https://auth.example.test",
      audience: "cardscope-api",
      fetch: fetchMock,
    });

    const principal = await authenticator.authenticate(
      new Request("https://cards.example.test/api/sync", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(principal).toMatchObject({
      subject: "user-123",
      email: "collector@example.test",
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://auth.example.test/.well-known/openid-configuration",
      "https://keys.example.test/jwks.json",
    ]);
  });

  it("should reject an insecure JWKS URI returned by discovery", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            issuer: "https://auth.example.test",
            jwks_uri: "http://keys.example.test/jwks.json",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const authenticator = new OidcAuthenticator({
      issuer: "https://auth.example.test",
      audience: "cardscope-api",
      fetch: fetchMock,
    });

    await expect(
      authenticator.authenticate(
        new Request("https://cards.example.test/api/sync", {
          headers: { Authorization: "Bearer opaque-token" },
        }),
      ),
    ).rejects.toMatchObject({ name: "AuthenticationError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
