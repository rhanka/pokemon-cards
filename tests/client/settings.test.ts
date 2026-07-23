import { cleanup, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../../src/lib/components/SettingsPage.svelte";
import type { RuntimeConfig } from "../../src/lib/types";

const config: RuntimeConfig = {
  appName: "CardScope",
  auth: {
    enabled: true,
    issuer: "https://auth.example.test",
    clientId: "cardscope",
    scope: "openid",
  },
  vision: { enabled: false },
  sync: { enabled: true, retentionDays: 1826 },
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
    onLocale: vi.fn(),
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
  it("should notify the app when the user selects French in the design-system tabs", async () => {
    const onLocale = vi.fn();
    renderSettings({ onLocale });

    await userEvent.click(screen.getByRole("tab", { name: "Français" }));

    expect(onLocale).toHaveBeenCalledWith("fr");
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
    renderSettings({ onImport });

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
    renderSettings({ onImport });
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
      screen.getByRole("button", { name: /Delete active server copy/i }),
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("local collection remains"),
    );
    expect(onDeleteCloud).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Local data was kept/i)).toBeInTheDocument();
  });
});
