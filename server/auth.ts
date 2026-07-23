import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
} from "jose";

import {
  normalizedOidcUrl,
  oidcUrlUsesLoopback,
  type RuntimeConfig,
} from "./config.js";

export interface AuthPrincipal {
  subject: string;
  email: string | null;
  claims: Record<string, unknown>;
}

export interface Authenticator {
  authenticate(request: Request): Promise<AuthPrincipal>;
}

export class AuthenticationError extends Error {
  constructor(message = "A valid bearer token is required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthenticationUnavailableError extends Error {
  constructor() {
    super("Cloud sync is disabled until OIDC is configured");
    this.name = "AuthenticationUnavailableError";
  }
}

export class DisabledAuthenticator implements Authenticator {
  async authenticate(): Promise<AuthPrincipal> {
    throw new AuthenticationUnavailableError();
  }
}

export class OidcAuthenticator implements Authenticator {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clientId: string;
  private readonly requiredScopes: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null =
    null;

  constructor(options: {
    issuer: string;
    audience: string;
    clientId: string;
    requiredScopes?: readonly string[];
    jwksUri?: string | null;
    fetch?: typeof fetch;
  }) {
    this.issuer = normalizedOidcUrl(options.issuer, "OIDC issuer");
    this.audience = options.audience;
    this.clientId = options.clientId;
    this.requiredScopes = options.requiredScopes ?? ["openid"];
    this.fetchImpl = options.fetch ?? fetch;
    if (options.jwksUri) {
      const jwksUri = normalizedOidcUrl(options.jwksUri, "OIDC JWKS URI");
      if (
        new URL(jwksUri).protocol === "http:" &&
        !oidcUrlUsesLoopback(this.issuer)
      ) {
        throw new Error(
          "OIDC JWKS URI may use HTTP only with a localhost or loopback issuer",
        );
      }
      this.jwks = this.createJwks(new URL(jwksUri));
    } else {
      this.jwks = null;
    }
  }

  private createJwks(uri: URL): ReturnType<typeof createRemoteJWKSet> {
    return createRemoteJWKSet(uri, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1_000,
      timeoutDuration: 3_000,
      [customFetch]: (url, init) => this.fetchImpl(url, init),
    });
  }

  private async discoverJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.jwks) return this.jwks;
    if (this.jwksPromise) return this.jwksPromise;

    this.jwksPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await this.fetchImpl(
          `${this.issuer}/.well-known/openid-configuration`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new AuthenticationError();
        const discovery = (await response.json()) as Record<string, unknown>;
        const discoveredIssuer =
          typeof discovery.issuer === "string"
            ? discovery.issuer.replace(/\/$/, "")
            : null;
        if (
          discoveredIssuer !== this.issuer ||
          typeof discovery.jwks_uri !== "string"
        ) {
          throw new AuthenticationError();
        }
        const uri = new URL(
          normalizedOidcUrl(discovery.jwks_uri, "discovered OIDC JWKS URI"),
        );
        if (uri.protocol === "http:" && !oidcUrlUsesLoopback(this.issuer)) {
          throw new AuthenticationError();
        }
        this.jwks = this.createJwks(uri);
        return this.jwks;
      } finally {
        clearTimeout(timeout);
      }
    })();

    try {
      return await this.jwksPromise;
    } catch (error) {
      this.jwksPromise = null;
      throw error;
    }
  }

  async authenticate(request: Request): Promise<AuthPrincipal> {
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) throw new AuthenticationError();

    try {
      const verified = await jwtVerify(match[1], await this.discoverJwks(), {
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: ["sub", "exp", "iat", "client_id", "scope"],
      });
      if (!verified.payload.sub) throw new AuthenticationError();
      if (verified.payload.client_id !== this.clientId)
        throw new AuthenticationError();
      const scopes =
        typeof verified.payload.scope === "string"
          ? new Set(verified.payload.scope.split(/\s+/).filter(Boolean))
          : new Set<string>();
      if (this.requiredScopes.some((scope) => !scopes.has(scope)))
        throw new AuthenticationError();

      return {
        // OIDC `sub` is stable only inside its issuer namespace.
        subject: `${this.issuer}|${verified.payload.sub}`,
        email:
          typeof verified.payload.email === "string"
            ? verified.payload.email
            : null,
        claims: { ...verified.payload },
      };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof joseErrors.JOSEError)
        throw new AuthenticationError();
      throw new AuthenticationError();
    }
  }
}

export function createAuthenticator(config: RuntimeConfig): Authenticator {
  if (!config.oidc.enabled) return new DisabledAuthenticator();
  if (!config.oidc.issuer) {
    throw new Error("OIDC issuer is required when authentication is enabled");
  }
  if (!config.oidc.audience) {
    throw new Error("OIDC audience is required when authentication is enabled");
  }
  return new OidcAuthenticator({
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    clientId: config.oidc.clientId,
    requiredScopes: ["openid"],
    jwksUri: config.oidc.jwksUri,
  });
}
