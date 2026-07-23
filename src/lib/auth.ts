import { writable, type Readable } from "svelte/store";
import type { OidcSession, RuntimeConfig } from "./types";

export type AuthState = {
  status: "disabled" | "loading" | "anonymous" | "authenticated" | "error";
  session?: OidcSession;
  error?: string;
};

type UserManagerLike = import("oidc-client-ts").UserManager;

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
        extraQueryParams: config.audience
          ? { audience: config.audience }
          : undefined,
        // Access tokens are session-scoped so a closed browser does not leave a
        // long-lived bearer token behind on a shared device.
        userStore: new WebStorageStateStore({ store: window.sessionStorage }),
        stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
        automaticSilentRenew: false,
      });
      if (
        window.location.pathname === "/auth/callback" &&
        new URLSearchParams(window.location.search).has("code")
      ) {
        await this.manager.signinRedirectCallback(window.location.href);
        history.replaceState({}, document.title, "/");
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
    await this.manager.signinRedirect({ url_state: window.location.pathname });
  }

  async signOut(): Promise<void> {
    if (!this.manager) return;
    await this.manager.signoutRedirect();
  }
}

export const authClient = new AuthClient();
