import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { AuthClient } from "../../src/lib/auth";

describe("AuthClient sign-out", () => {
  it("uses the provider end-session redirect", async () => {
    const client = new AuthClient();
    const signoutRedirect = vi.fn().mockResolvedValue(undefined);
    Object.assign(client, {
      manager: { signoutRedirect },
    });

    await client.signOut();

    expect(signoutRedirect).toHaveBeenCalledOnce();
    expect(get(client.state)).toEqual({ status: "anonymous" });
  });

  it("clears the local bearer-token session if provider logout fails", async () => {
    const client = new AuthClient();
    const removeUser = vi.fn().mockResolvedValue(undefined);
    const clearStaleState = vi.fn().mockResolvedValue(undefined);
    Object.assign(client, {
      manager: {
        signoutRedirect: vi.fn().mockRejectedValue(new Error("unavailable")),
        removeUser,
        clearStaleState,
      },
    });

    await client.signOut();

    expect(removeUser).toHaveBeenCalledOnce();
    expect(clearStaleState).toHaveBeenCalledOnce();
    expect(get(client.state)).toEqual({ status: "anonymous" });
  });
});
