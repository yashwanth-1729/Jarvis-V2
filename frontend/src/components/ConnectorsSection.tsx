"use client";

/**
 * Settings > Connectors: sync passphrase, the Google connector, MCP servers.
 *
 * Every change is saved immediately (not on the panel's "Save & reload"),
 * synced, and handed to the runtime -- a sign-in that only took effect after
 * a reload would look broken.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { getPassphrase, setPassphrase } from "@/lib/connectorCrypto";
import {
  type ConnectorRow,
  type ConnectorStatus,
  type GoogleConfig,
  type GoogleSecret,
  type GoogleService,
  type McpConfig,
  type McpSecret,
  listConnectors,
  newUid,
  openSecret,
  parseConfig,
  refreshConnectors,
  removeConnector,
  seal,
  startGoogleSignIn,
  testMcpServer,
  upsertConnector,
  waitForGoogleSignIn,
} from "@/lib/connectors";

const INPUT =
  "h-11 w-full rounded border border-line bg-surface-2 px-3 font-mono text-lg text-ink " +
  "placeholder:text-ink-faint focus:border-accent focus:outline-none sm:text-xs";
const BUTTON =
  "inline-flex h-11 items-center justify-center rounded border border-line px-4 text-sm " +
  "text-ink hover:border-accent focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-accent/50 disabled:opacity-50";
const PRIMARY =
  "inline-flex h-11 items-center justify-center rounded bg-accent px-4 text-sm font-semibold " +
  "text-accent-ink hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-accent/50 disabled:opacity-50";
const SERVICES: Array<{ id: GoogleService; label: string }> = [
  { id: "gmail", label: "Gmail" },
  { id: "calendar", label: "Calendar" },
  { id: "drive", label: "Drive" },
];

export function ConnectorsSection() {
  const [rows, setRows] = React.useState<ConnectorRow[]>(() => listConnectors());
  const [status, setStatus] = React.useState<ConnectorStatus | null>(null);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [passphrase, setPassphraseInput] = React.useState(() => getPassphrase());
  const hasPassphrase = Boolean(getPassphrase());

  const refresh = React.useCallback(async (note?: string) => {
    setBusy(true);
    const result = await refreshConnectors();
    setRows(listConnectors());
    setStatus(result.status);
    const parts = [note];
    if (result.sync.error) parts.push(`Sync: ${result.sync.error}`);
    if (result.locked.length) parts.push(`Locked (different passphrase): ${result.locked.join(", ")}`);
    if (!result.status) parts.push("The runtime did not answer; connectors apply on the next connect.");
    setMessage(parts.filter(Boolean).join(" · "));
    setBusy(false);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const savePassphrase = async () => {
    if (passphrase.trim().length < 8) {
      setMessage("Use at least 8 characters, and the same passphrase on every device.");
      return;
    }
    setPassphrase(passphrase.trim());
    await refresh("Passphrase saved on this device.");
  };

  return (
    <section className="space-y-4 border-t border-line pt-5">
      <div>
        <h3 className="text-sm font-medium text-ink">Connectors</h3>
        <p className="text-xs leading-relaxed text-ink-dim">
          Let JARVIS use Google and MCP servers. Connectors sync between your devices;
          their keys are encrypted here with your sync passphrase before they leave.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="connector-passphrase" className="block text-xs font-medium text-ink">
          Sync passphrase {hasPassphrase ? <span className="text-accent">· set</span> : null}
        </label>
        <div className="flex gap-2">
          <input
            id="connector-passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphraseInput(event.target.value)}
            placeholder="Same on phone and laptop"
            className={INPUT}
          />
          <button type="button" className={BUTTON} onClick={() => void savePassphrase()}>
            Save
          </button>
        </div>
        <p className="text-xs text-ink-dim">
          Not recoverable: if you forget it, reconnect Google and re-enter server keys.
        </p>
      </div>

      <GoogleCard
        row={rows.find((r) => r.kind === "google")}
        status={status}
        disabled={!hasPassphrase || busy}
        onChanged={refresh}
      />

      <McpList
        rows={rows.filter((r) => r.kind === "mcp")}
        status={status}
        disabled={!hasPassphrase || busy}
        onChanged={refresh}
      />

      {!hasPassphrase && (
        <p className="text-xs text-ink-dim">Set the sync passphrase to add connectors.</p>
      )}
      {message && (
        <p aria-live="polite" className="text-xs text-ink-dim">
          {message}
        </p>
      )}
    </section>
  );
}

function GoogleCard({
  row, status, disabled, onChanged,
}: {
  row: ConnectorRow | undefined;
  status: ConnectorStatus | null;
  disabled: boolean;
  onChanged: (note?: string) => Promise<void>;
}) {
  const config = row ? parseConfig<GoogleConfig>(row) : null;
  const [clientId, setClientId] = React.useState(config?.client_id ?? "");
  const [clientSecret, setClientSecret] = React.useState("");
  const [services, setServices] = React.useState<GoogleService[]>(
    config?.services ?? ["gmail", "calendar", "drive"],
  );
  const [pending, setPending] = React.useState<{ url: string; controller: AbortController } | null>(null);
  const [error, setError] = React.useState("");
  const connected = status?.google.connected;

  React.useEffect(() => {
    if (!row) return;
    void openSecret<GoogleSecret>(row)
      .then((secret) => secret && setClientSecret(secret.client_secret ?? ""))
      .catch(() => undefined);
  }, [row]);

  const connect = async () => {
    setError("");
    try {
      const { state, auth_url } = await startGoogleSignIn(clientId.trim(), clientSecret.trim(), services);
      const controller = new AbortController();
      setPending({ url: auth_url, controller });
      const timer = setTimeout(() => controller.abort(), 5 * 60_000);
      const outcome = await waitForGoogleSignIn(state, controller.signal).finally(() => clearTimeout(timer));
      upsertConnector({
        uid: row?.uid ?? newUid(),
        kind: "google",
        name: "Google",
        config: JSON.stringify({ client_id: clientId.trim(), services: outcome.services, email: outcome.email }),
        secret: await seal({ client_secret: clientSecret.trim(), refresh_token: outcome.refresh_token }),
      });
      setPending(null);
      await onChanged(`Google connected as ${outcome.email || "your account"}.`);
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = async () => {
    if (!row) return;
    removeConnector(row.uid);
    await onChanged("Google disconnected on every device. To revoke access fully, remove JARVIS at myaccount.google.com/permissions.");
  };

  return (
    <div className="space-y-2 rounded border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">Google</span>
        <span className={cn("text-xs", connected ? "text-accent" : "text-ink-dim")}>
          {connected ? `Connected · ${status?.google.email ?? ""}` : row ? "Saved, not connected here" : "Not connected"}
        </span>
      </div>
      {!connected && (
        <>
          <p className="text-xs leading-relaxed text-ink-dim">
            Needs your own free Google Cloud OAuth client (type &ldquo;Desktop app&rdquo;) with the
            Gmail, Calendar and Drive APIs enabled. Sign in once on the laptop; the phone gets it
            through sync.
          </p>
          <input
            aria-label="Google OAuth client ID"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder="Client ID …apps.googleusercontent.com"
            className={INPUT}
          />
          <input
            aria-label="Google OAuth client secret"
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder="Client secret"
            className={INPUT}
          />
          <div className="flex flex-wrap gap-3" role="group" aria-label="Google services">
            {SERVICES.map((service) => (
              <label key={service.id} className="inline-flex min-h-11 items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={services.includes(service.id)}
                  onChange={(event) =>
                    setServices((current) =>
                      event.target.checked ? [...current, service.id] : current.filter((s) => s !== service.id),
                    )
                  }
                  className="h-4 w-4 accent-accent"
                />
                {service.label}
              </label>
            ))}
          </div>
        </>
      )}
      {pending ? (
        <div className="space-y-2">
          <p className="text-xs text-ink">
            Finish signing in in your browser. If it did not open,{" "}
            <a href={pending.url} target="_blank" rel="noreferrer" className="text-accent underline">
              open the Google sign-in page
            </a>
            .
          </p>
          <button type="button" className={BUTTON} onClick={() => pending.controller.abort()}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {!connected && (
            <button
              type="button"
              className={PRIMARY}
              disabled={disabled || !clientId.trim() || !clientSecret.trim() || !services.length}
              onClick={() => void connect()}
            >
              {row ? "Reconnect Google" : "Connect Google"}
            </button>
          )}
          {row && (
            <button type="button" className={BUTTON} disabled={disabled} onClick={() => void disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-critical">{error}</p>}
    </div>
  );
}

function McpList({
  rows, status, disabled, onChanged,
}: {
  rows: ConnectorRow[];
  status: ConnectorStatus | null;
  disabled: boolean;
  onChanged: (note?: string) => Promise<void>;
}) {
  const [adding, setAdding] = React.useState(false);

  const toggleTool = async (row: ConnectorRow, tool: string, enabled: boolean) => {
    const config = parseConfig<McpConfig>(row);
    const off = new Set(config.disabled_tools ?? []);
    if (enabled) off.delete(tool);
    else off.add(tool);
    upsertConnector({ ...row, config: JSON.stringify({ ...config, disabled_tools: [...off] }) });
    await onChanged();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">MCP servers</span>
        {!adding && (
          <button type="button" className={BUTTON} disabled={disabled} onClick={() => setAdding(true)}>
            Add server
          </button>
        )}
      </div>
      {rows.length === 0 && !adding && (
        <p className="text-xs text-ink-dim">No MCP servers yet.</p>
      )}
      {rows.map((row) => {
        const config = parseConfig<McpConfig>(row);
        const live = status?.mcp.find((s) => s.id === row.uid);
        return (
          <details key={row.uid} className="rounded border border-line p-3">
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm text-ink">
              <span>{row.name}</span>
              <span className={cn("text-xs", live?.connected ? "text-accent" : "text-ink-dim")}>
                {live?.connected
                  ? live.tools.every((t) => t.enabled)
                    ? `${live.tools.length} tools`
                    : `${live.tools.filter((t) => t.enabled).length} of ${live.tools.length} tools on`
                  : live?.error || (config.transport === "stdio" ? "Laptop only" : "Not connected")}
              </span>
            </summary>
            <p className="mt-2 break-all font-mono text-xs text-ink-dim">
              {config.transport === "stdio" ? `${config.command} ${(config.args ?? []).join(" ")}` : config.url}
            </p>
            {live?.tools.map((tool) => (
              <label key={tool.name} className="flex min-h-11 items-start gap-2 py-1 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={tool.enabled}
                  onChange={(event) => void toggleTool(row, tool.name, event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-accent"
                />
                <span>
                  <span className="font-mono">{tool.name}</span>
                  {tool.read_only ? <span className="text-ink-dim"> · read-only</span> : <span className="text-ink-dim"> · asks first</span>}
                  <span className="block text-ink-dim">{tool.description}</span>
                </span>
              </label>
            ))}
            <button
              type="button"
              className={cn(BUTTON, "mt-2 text-critical")}
              disabled={disabled}
              onClick={() => {
                removeConnector(row.uid);
                void onChanged(`${row.name} removed on every device.`);
              }}
            >
              Remove
            </button>
          </details>
        );
      })}
      {adding && (
        <McpForm
          onCancel={() => setAdding(false)}
          onSaved={async (name) => {
            setAdding(false);
            await onChanged(`${name} added.`);
          }}
        />
      )}
    </div>
  );
}

function McpForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (name: string) => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [transport, setTransport] = React.useState<"http" | "stdio">("http");
  const [url, setUrl] = React.useState("");
  const [command, setCommand] = React.useState("");
  const [header, setHeader] = React.useState("Authorization");
  const [headerValue, setHeaderValue] = React.useState("");
  const [result, setResult] = React.useState<string>("");
  const [testing, setTesting] = React.useState(false);

  const definition = () => {
    const [cmd, ...args] = command.trim().split(/\s+/).filter(Boolean);
    const headers = header.trim() && headerValue.trim() ? { [header.trim()]: headerValue.trim() } : {};
    return {
      config: transport === "http"
        ? { transport, url: url.trim(), enabled: true, disabled_tools: [] }
        : { transport, command: cmd ?? "", args, enabled: true, disabled_tools: [] },
      secret: { headers } as McpSecret,
    };
  };

  const test = async () => {
    setTesting(true);
    const { config, secret } = definition();
    const outcome = await testMcpServer({ id: "test", name: name || "server", ...config, ...secret });
    setResult(outcome.ok
      ? `Connected · ${outcome.tools.length} tools: ${outcome.tools.map((t) => t.name).slice(0, 8).join(", ")}`
      : `Failed: ${outcome.error}`);
    setTesting(false);
  };

  const save = async () => {
    const { config, secret } = definition();
    upsertConnector({
      uid: newUid(), kind: "mcp", name: name.trim(),
      config: JSON.stringify(config as McpConfig),
      secret: Object.keys(secret.headers ?? {}).length ? await seal(secret) : null,
    });
    await onSaved(name.trim());
  };

  const ready = name.trim() && (transport === "http" ? /^https?:\/\//.test(url.trim()) : command.trim());

  return (
    <div className="space-y-2 rounded border border-line p-3">
      <input aria-label="Server name" value={name} onChange={(e) => setName(e.target.value)}
        placeholder="Name (e.g. GitHub)" className={INPUT} />
      <div className="flex gap-2" role="group" aria-label="Server type">
        {(["http", "stdio"] as const).map((kind) => (
          <button key={kind} type="button" onClick={() => setTransport(kind)}
            className={cn(BUTTON, "flex-1", transport === kind && "border-accent bg-accent/10")}>
            {kind === "http" ? "URL (phone + laptop)" : "Command (laptop only)"}
          </button>
        ))}
      </div>
      {transport === "http" ? (
        <>
          <input aria-label="Server URL" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp" className={INPUT} />
          <div className="flex gap-2">
            <input aria-label="Auth header name" value={header} onChange={(e) => setHeader(e.target.value)}
              placeholder="Header" className={cn(INPUT, "w-2/5")} />
            <input aria-label="Auth header value" type="password" value={headerValue}
              onChange={(e) => setHeaderValue(e.target.value)} placeholder="Bearer … (optional)" className={INPUT} />
          </div>
        </>
      ) : (
        <input aria-label="Command" value={command} onChange={(e) => setCommand(e.target.value)}
          placeholder="npx -y @modelcontextprotocol/server-filesystem D:\Notes" className={INPUT} />
      )}
      {result && <p className="text-xs text-ink-dim">{result}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} disabled={!ready || testing} onClick={() => void test()}>
          {testing ? "Testing…" : "Test"}
        </button>
        <button type="button" className={PRIMARY} disabled={!ready} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
