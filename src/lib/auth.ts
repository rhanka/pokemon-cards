import { writable, type Readable } from "svelte/store";
import type { OidcSession, RuntimeConfig } from "./types";

export type AuthState = {
  status: "disabled" | "loading" | "anonymous" | "authenticated" | "error";
  session?: OidcSession;
  error?: string;
};

type UserManagerLike = import("oidc-client-ts").UserManager;

function safeReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return "/";
  try {
    const candidate = new URL(value, window.location.origin);
    if (
      candidate.origin !== window.location.origin ||
      candidate.pathname === "/auth/callback"
    )
      return "/";
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return "/";
  }
}

export class AuthClient {
  private manager: UserManagerLike | null = null;
  private readonly internal = writable<AuthState>({ status: "loading" });
  readonly state: Readable<AuthState> = { subscribe: this.internal.subscribe };

  async init(config: RuntimeConfig["auth"]): Promise<void> {
    if (!config.enabled || !config.issuer || !config.clientId) {
      this.internal.set({ status: "disabled" });
      return;
    }
    try {
      const { UserManager, WebStorageStateStore } =
        await import("oidc-client-ts");
      this.manager = new UserManager({
        authority: config.issuer,
        client_id: config.clientId,
        redirect_uri: `${window.location.origin}/auth/callback`,
        post_logout_redirect_uri: `${window.location.origin}/`,
        response_type: "code",
        scope: config.scope,
        // Sentropic follows RFC 8707 resource indicators for access-token
        // audience binding.
        extraQueryParams: config.audience
          ? { resource: config.audience }
          : undefined,
        // Access tokens are session-scoped so a closed browser does not leave a
        // long-lived bearer token behind on a shared device.
        userStore: new WebStorageStateStore({ store: window.sessionStorage }),
        stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
        automaticSilentRenew: false,
      });
      this.manager.events.addAccessTokenExpired(() => {
        void this.clearLocalSession();
      });
      if (
        window.location.pathname === "/auth/callback" &&
        new URLSearchParams(window.location.search).has("code")
      ) {
        const user = await this.manager.signinRedirectCallback(
          window.location.href,
        );
        history.replaceState(
          {},
          document.title,
          safeReturnPath(user.url_state),
        );
      }
      const user = await this.manager.getUser();
      if (user && !user.expired) {
        this.internal.set({
          status: "authenticated",
          session: {
            accessToken: user.access_token,
            expiresAt: user.expires_at,
            profile: user.profile,
          },
        });
      } else {
        this.internal.set({ status: "anonymous" });
      }
    } catch (error) {
      this.internal.set({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async signIn(): Promise<void> {
    if (!this.manager) return;
    const current =
      window.location.pathname === "/auth/callback"
        ? "/"
        : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    await this.manager.signinRedirect({ url_state: safeReturnPath(current) });
  }

  async signOut(): Promise<void> {
    if (!this.manager) {
      this.internal.set({ status: "disabled" });
      return;
    }
    try {
      // UserManager removes its session-scoped token before navigating to the
      // provider's end-session endpoint. Production enrollment remains gated
      // until that provider behavior is verified end to end.
      await this.manager.signoutRedirect();
      this.internal.set({ status: "anonymous" });
    } catch {
      // Provider logout may be unavailable or unreachable. Always end the
      // local bearer-token session; the account-scoped offline cache remains
      // preserved so queued changes are not destroyed.
      await this.clearLocalSession();
    }
  }

  private async clearLocalSession(): Promise<void> {
    if (this.manager) {
      await this.manager.removeUser();
      await this.manager.clearStaleState();
    }
    this.internal.set({ status: this.manager ? "anonymous" : "disabled" });
  }
}

export const authClient = new AuthClient();
