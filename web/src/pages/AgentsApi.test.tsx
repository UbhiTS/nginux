import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsApi } from "./AgentsApi.tsx";
import { api, type ApiToken, type Approval, type ToolDef, type Webhook } from "../api.ts";

// The page loads several resources on mount (overview stats, approvals, activity,
// settings) plus per-tab lists (tools/tokens on MCP, webhooks on Events). Mock every
// method it can touch so no tab throws.
vi.mock("../api.ts", () => ({
  api: {
    agentsOverview: vi.fn(),
    approvals: vi.fn(),
    audit: vi.fn(),
    settings: vi.fn(),
    saveSettings: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    tools: vi.fn(),
    tokens: vi.fn(),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
    webhooks: vi.fn(),
    createWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
  },
}));

const overview = { agents: 2, tools: 5, pendingApprovals: 1, webhooks: 1 };

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "ap1",
  ts: "2026-07-01T00:00:00Z",
  agent: "claude",
  tool: "host.create",
  args: {},
  tier: "high",
  summary: "create host app.example.com",
  status: "pending",
  result: null,
  decidedBy: null,
  decidedAt: null,
  ...over,
});

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: "t1",
  name: "claude-desktop",
  prefix: "ab12",
  scopes: ["read"],
  trust: "untrusted",
  createdAt: "2026-07-01T00:00:00Z",
  lastUsedAt: null,
  revoked: false,
  ...over,
});

const tool = (over: Partial<ToolDef> = {}): ToolDef => ({
  name: "host.list",
  title: "List hosts",
  description: "List all proxy hosts",
  scope: "read",
  tier: "read",
  inputSchema: {},
  ...over,
});

const webhook = (over: Partial<Webhook> = {}): Webhook => ({
  id: "w1",
  url: "https://hooks.example.com/x",
  events: ["*"],
  lastStatus: null,
  lastDeliveryAt: null,
  createdAt: "2026-07-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.agentsOverview).mockResolvedValue({ ...overview });
  vi.mocked(api.approvals).mockResolvedValue([approval()]);
  vi.mocked(api.audit).mockResolvedValue([]);
  vi.mocked(api.settings).mockResolvedValue({ agentAutoApprove: false } as never);
  vi.mocked(api.saveSettings).mockResolvedValue({ agentAutoApprove: true } as never);
  vi.mocked(api.approve).mockResolvedValue(approval({ status: "executed" }));
  vi.mocked(api.deny).mockResolvedValue(approval({ status: "denied" }));
  vi.mocked(api.tools).mockResolvedValue([tool()]);
  vi.mocked(api.tokens).mockResolvedValue([token()]);
  vi.mocked(api.createToken).mockResolvedValue({ token: "ngx_realsecret123", record: token() });
  vi.mocked(api.revokeToken).mockResolvedValue({ ok: true });
  vi.mocked(api.webhooks).mockResolvedValue([webhook()]);
  vi.mocked(api.createWebhook).mockResolvedValue({ webhook: webhook(), secret: "s" });
  vi.mocked(api.deleteWebhook).mockResolvedValue({ ok: true });
});

const setTab = vi.fn();

describe("AgentsApi — overview", () => {
  it("renders the stat cards from the overview bundle once loaded", async () => {
    render(<AgentsApi tab="overview" setTab={setTab} />);

    const agents = await screen.findByText("Connected agents");
    expect(within(agents.closest(".stat") as HTMLElement).getByText("2")).toBeInTheDocument();
    const tools = screen.getByText("Tools exposed");
    expect(within(tools.closest(".stat") as HTMLElement).getByText("5")).toBeInTheDocument();
  });

  it("surfaces an error state (with retry) when the bundle fails to load", async () => {
    vi.mocked(api.agentsOverview).mockRejectedValue(new Error("network down"));
    render(<AgentsApi tab="overview" setTab={setTab} />);

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows the pending-approvals badge and approves via api.approve", async () => {
    render(<AgentsApi tab="overview" setTab={setTab} />);
    await screen.findByText("Connected agents");

    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith("ap1"));
  });

  it("disables the approve/deny pair while a decision is in flight (re-entry guard)", async () => {
    let resolve!: (v: Approval) => void;
    vi.mocked(api.approve).mockReturnValue(new Promise<Approval>((r) => { resolve = r; }));
    render(<AgentsApi tab="overview" setTab={setTab} />);
    await screen.findByText("Connected agents");

    const approve = screen.getByRole("button", { name: /Approve/ });
    const deny = screen.getByRole("button", { name: /Deny/ });
    await userEvent.click(approve);
    expect(approve).toBeDisabled();
    expect(deny).toBeDisabled();
    // Only one call even if we try again while busy.
    await userEvent.click(approve);
    expect(api.approve).toHaveBeenCalledTimes(1);
    resolve(approval({ status: "executed" }));
  });

  it("surfaces a decision error instead of swallowing it", async () => {
    vi.mocked(api.deny).mockRejectedValue(new Error("approval vanished"));
    render(<AgentsApi tab="overview" setTab={setTab} />);
    await screen.findByText("Connected agents");

    await userEvent.click(screen.getByRole("button", { name: /Deny/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/approval vanished/i);
  });

  it("renders a zero-state when there is no recent agent activity", async () => {
    render(<AgentsApi tab="overview" setTab={setTab} />);
    expect(await screen.findByText(/No agent activity yet\./i)).toBeInTheDocument();
  });
});

describe("AgentsApi — MCP tab", () => {
  it("lists tokens and shows a zero-state when there are none", async () => {
    vi.mocked(api.tokens).mockResolvedValue([]);
    render(<AgentsApi tab="mcp" setTab={setTab} />);
    expect(await screen.findByText(/No API tokens yet/i)).toBeInTheDocument();
  });

  it("creates a token, reveals it with a Copy button, and drops it into the config block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AgentsApi tab="mcp" setTab={setTab} />);
    await screen.findByText("Endpoints");

    await userEvent.type(screen.getByLabelText("Token name"), "ci-bot");
    await userEvent.click(screen.getByRole("button", { name: /Create token/ }));

    await waitFor(() => expect(api.createToken).toHaveBeenCalledWith("ci-bot", ["read"], "untrusted"));
    // The freshly-minted token appears verbatim (not a masked span).
    expect(await screen.findByText("ngx_realsecret123")).toBeInTheDocument();
    // And is interpolated into the drop-in config (Bearer <token>).
    expect(screen.getByText(/Bearer ngx_realsecret123/)).toBeInTheDocument();

    // Copy button copies the real token and flips to "Copied".
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("ngx_realsecret123");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("submits the token form on Enter", async () => {
    render(<AgentsApi tab="mcp" setTab={setTab} />);
    await screen.findByText("Endpoints");

    const name = screen.getByLabelText("Token name");
    await userEvent.type(name, "enter-bot{Enter}");
    await waitFor(() => expect(api.createToken).toHaveBeenCalledWith("enter-bot", ["read"], "untrusted"));
  });

  it("routes Revoke through a confirm dialog before calling api.revokeToken", async () => {
    render(<AgentsApi tab="mcp" setTab={setTab} />);
    await screen.findByText("claude-desktop");

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Revoke claude-desktop/i)).toBeInTheDocument();
    // Nothing happens until the user confirms.
    expect(api.revokeToken).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(api.revokeToken).toHaveBeenCalledWith("t1"));
  });
});

describe("AgentsApi — safety tab", () => {
  it("toggles the auto-approval policy through the Switch", async () => {
    render(<AgentsApi tab="safety" setTab={setTab} />);
    const sw = await screen.findByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");

    await userEvent.click(sw);
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ agentAutoApprove: true }));
  });
});

describe("AgentsApi — events tab", () => {
  it("maps raw webhook delivery status through a human label", async () => {
    vi.mocked(api.webhooks).mockResolvedValue([
      webhook({ id: "a", lastStatus: "ok" }),
      webhook({ id: "b", lastStatus: "error" }),
      webhook({ id: "c", lastStatus: null }),
    ]);
    render(<AgentsApi tab="events" setTab={setTab} />);

    expect(await screen.findByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Not tested")).toBeInTheDocument();
  });

  it("renders a 'Test: ok' delivery as a sentence", async () => {
    vi.mocked(api.webhooks).mockResolvedValue([webhook({ lastStatus: "test:ok" })]);
    render(<AgentsApi tab="events" setTab={setTab} />);
    expect(await screen.findByText("Test delivery succeeded")).toBeInTheDocument();
  });

  it("adds a webhook via the form and reloads the list", async () => {
    render(<AgentsApi tab="events" setTab={setTab} />);
    await screen.findByText("Outbound webhooks");

    await userEvent.type(screen.getByLabelText("Endpoint URL"), "https://new.example.com/hook{Enter}");
    await waitFor(() => expect(api.createWebhook).toHaveBeenCalledWith("https://new.example.com/hook", ["*"]));
  });

  it("routes Delete through a confirm dialog before calling api.deleteWebhook", async () => {
    render(<AgentsApi tab="events" setTab={setTab} />);
    await screen.findByText("https://hooks.example.com/x");

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.deleteWebhook).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete webhook" }));
    await waitFor(() => expect(api.deleteWebhook).toHaveBeenCalledWith("w1"));
  });

  it("shows a zero-state when there are no webhooks", async () => {
    vi.mocked(api.webhooks).mockResolvedValue([]);
    render(<AgentsApi tab="events" setTab={setTab} />);
    expect(await screen.findByText(/No webhooks yet/i)).toBeInTheDocument();
  });
});
