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
          clientId: "cardscope",
        }),
    ).toThrow("OIDC issuer must use HTTPS");
    expect(
      () =>
        new OidcAuthenticator({
          issuer: "https://auth.example.test",
          audience: "cardscope-api",
          clientId: "cardscope",
          jwksUri: "http://keys.example.test/jwks.json",
        }),
    ).toThrow("OIDC JWKS URI must use HTTPS");
    expect(
      () =>
        new OidcAuthenticator({
          issuer: "http://localhost:8080",
          audience: "cardscope-api",
          clientId: "cardscope",
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
    const token = await new SignJWT({
      client_id: "cardscope",
      email: "collector@example.test",
      scope: "openid profile email",
    })
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
      clientId: "cardscope",
      fetch: fetchMock,
    });

    const principal = await authenticator.authenticate(
      new Request("https://cards.example.test/api/sync", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(principal).toMatchObject({
      subject: "https://auth.example.test|user-123",
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
      clientId: "cardscope",
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

  it("should reject tokens with the wrong resource, client, scope, or expiry", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    Object.assign(publicJwk, {
      kid: "negative-signing-key",
      alg: "ES256",
      use: "sig",
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const authenticator = new OidcAuthenticator({
      issuer: "https://auth.example.test",
      audience: "https://cards.example.test/api",
      clientId: "pokemon-cards",
      requiredScopes: ["openid"],
      jwksUri: "https://auth.example.test/.well-known/jwks.json",
      fetch: fetchMock,
    });
    const sign = (claims: {
      audience?: string;
      clientId?: string;
      scope?: string;
      expiresIn?: string;
    }) =>
      new SignJWT({
        client_id: claims.clientId ?? "pokemon-cards",
        scope: claims.scope ?? "openid profile email",
      })
        .setProtectedHeader({ alg: "ES256", kid: "negative-signing-key" })
        .setIssuer("https://auth.example.test")
        .setAudience(claims.audience ?? "https://cards.example.test/api")
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime(claims.expiresIn ?? "5m")
        .sign(privateKey);

    for (const token of [
      await sign({ audience: "https://wrong.example.test/api" }),
      await sign({ clientId: "another-client" }),
      await sign({ scope: "profile email" }),
      await sign({ expiresIn: "-1s" }),
    ]) {
      await expect(
        authenticator.authenticate(
          new Request("https://cards.example.test/api/sync", {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ),
      ).rejects.toMatchObject({ name: "AuthenticationError" });
    }
  });

  it("should reject a signed access token without an expiration claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    Object.assign(publicJwk, {
      kid: "missing-exp-signing-key",
      alg: "ES256",
      use: "sig",
    });
    const authenticator = new OidcAuthenticator({
      issuer: "https://auth.example.test",
      audience: "https://cards.example.test/api",
      clientId: "pokemon-cards",
      requiredScopes: ["openid"],
      jwksUri: "https://auth.example.test/.well-known/jwks.json",
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ keys: [publicJwk] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const token = await new SignJWT({
      client_id: "pokemon-cards",
      scope: "openid profile email",
    })
      .setProtectedHeader({ alg: "ES256", kid: "missing-exp-signing-key" })
      .setIssuer("https://auth.example.test")
      .setAudience("https://cards.example.test/api")
      .setSubject("user-123")
      .setIssuedAt()
      .sign(privateKey);

    await expect(
      authenticator.authenticate(
        new Request("https://cards.example.test/api/sync", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
    ).rejects.toMatchObject({ name: "AuthenticationError" });
  });
});
