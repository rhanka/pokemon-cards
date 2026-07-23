import { cleanup, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../../src/lib/components/SettingsPage.svelte";
import type { RuntimeConfig } from "../../src/lib/types";

const config: RuntimeConfig = {
  appName: "CardScope",
  recognition: {
    enabled: true,
    processing: "server",
    maxImageBytes: 2 * 1024 * 1024,
  },
  auth: {
    enabled: true,
    issuer: "https://auth.example.test",
    clientId: "cardscope",
    scope: "openid",
  },
  sync: {
    enabled: true,
    retentionDays: 1826,
    maxBatchSize: 100,
    maxOperationBytes: 64 * 1024,
  },
  valuation: { marketQuotesEnabled: true },
};

function renderSettings(overrides: Record<string, unknown> = {}) {
  return render(SettingsPage, {
    locale: "en",
    snapshot: { holdings: [], activities: [], eventCount: 0 },
    config,
    authState: {
      status: "authenticated",
      session: { accessToken: "token", profile: { email: "me@example.test" } },
    },
    syncState: "idle",
    valuationPreference: { market: "tcgplayer", currency: "USD" },
    onValuationPreference: vi.fn(),
    onExportJson: vi.fn(),
    onExportCsv: vi.fn(),
    onImport: vi.fn(),
    onSignIn: vi.fn(),
    onSignOut: vi.fn(),
    onSync: vi.fn(),
    onDeleteCloud: vi.fn(),
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("settings interactions", () => {
  it("should leave interface language selection to the application menu", () => {
    renderSettings();

    expect(
      screen.queryByRole("heading", { name: "Language" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("should expose market and currency preferences independently from interface language", async () => {
    const onValuationPreference = vi.fn();
    renderSettings({ locale: "fr", onValuationPreference });

    await userEvent.selectOptions(
      screen.getByLabelText("Marché de référence"),
      "cardmarket",
    );
    expect(onValuationPreference).toHaveBeenCalledWith({
      market: "cardmarket",
      currency: "USD",
    });

    await userEvent.selectOptions(
      screen.getByLabelText("Devise de référence"),
      "EUR",
    );
    expect(onValuationPreference).toHaveBeenLastCalledWith({
      market: "tcgplayer",
      currency: "EUR",
    });
  });

  it("should require an explicit replace choice and confirmation before restoring a JSON backup", async () => {
    const onImport = vi.fn().mockResolvedValue(3);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderSettings({ authState: { status: "anonymous" }, onImport });

    await userEvent.click(
      screen.getByRole("radio", { name: /Replace active collection/i }),
    );
    const input = screen.getByLabelText(/Import JSON or CSV/i);
    const backup = new File(["[]"], "backup.json", {
      type: "application/json",
    });
    await userEvent.upload(input, backup);

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("erase the active collection"),
    );
    expect(onImport).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await userEvent.upload(input, backup);

    expect(onImport).toHaveBeenCalledWith(backup, "replace");
    expect(await screen.findByText(/3 events imported/i)).toBeInTheDocument();
  });

  it("should merge JSON by default and always append CSV imports", async () => {
    const onImport = vi.fn().mockResolvedValue(1);
    renderSettings({ authState: { status: "anonymous" }, onImport });
    const input = screen.getByLabelText(/Import JSON or CSV/i);

    const backup = new File(["[]"], "backup.json", {
      type: "application/json",
    });
    await userEvent.upload(input, backup);
    expect(onImport).toHaveBeenLastCalledWith(backup, "merge");

    await userEvent.click(
      screen.getByRole("radio", { name: /Replace active collection/i }),
    );
    const csv = new File(["card_id,name"], "collection.csv", {
      type: "text/csv",
    });
    await userEvent.upload(input, csv);
    expect(onImport).toHaveBeenLastCalledWith(csv, "merge");
  });

  it("should require confirmation before deleting only the active server copy", async () => {
    const onDeleteCloud = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderSettings({ onDeleteCloud });

    await userEvent.click(
      screen.getByRole("button", { name: /Delete account collection/i }),
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("account and this device"),
    );
    expect(onDeleteCloud).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(/deleted from your account and this device/i),
    ).toBeInTheDocument();
  });

  it("should prevent destructive local replacement for a centrally synchronized account", () => {
    renderSettings();

    expect(
      screen.getByRole("radio", { name: /Replace active collection/i }),
    ).toBeDisabled();
    expect(screen.getByText(/synchronized centrally/i)).toBeInTheDocument();
  });

  it("should present automatic-save status without a permanent manual sync control", () => {
    renderSettings({ syncState: "synced" });

    expect(
      screen.getByText(/All changes are saved to your account/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sync now|Retry saving/i }),
    ).not.toBeInTheDocument();
  });
});
