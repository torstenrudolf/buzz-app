import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Button } from "../shared/design-system/ui/Button";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Select } from "../shared/design-system/ui/Select";
import {
  developerSettings,
  isLogLevel,
  logLevel,
  LOG_LEVELS,
  subscribeLogLevel,
} from "../features/developer/logging";
import type { RelayData } from "../features/relay/service";
import { clientMetrics } from "../features/developer/client-metrics";
import { ClientMetricsPanel } from "./ClientMetricsPanel";

type BrokerStats = {
  queries: number;
  errors: number;
  media: number;
  connects: number;
};

const STATS_POLL_MS = 5000;

/** Only the dev broker serves /api/relay/*. Packaged builds and proxied
 * deployments have no such endpoint, so absence is normal, not an error. */
async function fetchStats(): Promise<BrokerStats | undefined> {
  try {
    const res = await fetch("/api/relay/stats");
    if (!res.ok) return undefined;
    return (await res.json()) as BrokerStats;
  } catch {
    return undefined;
  }
}

export function DeveloperSettings({ relay }: { relay: RelayData }) {
  const level = useSyncExternalStore(subscribeLogLevel, logLevel);
  const [settingsReady, setSettingsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  useEffect(() => {
    let alive = true;
    void developerSettings()
      .then(() => {
        if (alive) setSettingsReady(true);
      })
      .catch(() => {
        if (alive)
          setSettingsError(
            "Runtime settings require the local development server.",
          );
      });
    return () => {
      alive = false;
    };
  }, []);
  async function saveLevel(value: string) {
    if (!isLogLevel(value)) return;
    setSaving(true);
    setSettingsError(undefined);
    try {
      await developerSettings(value);
    } catch {
      setSettingsError("Log level wasn’t saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const [stats, setStats] = useState<BrokerStats>();
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    let alive = true;
    async function poll() {
      const next = await fetchStats();
      if (alive) setStats(next);
    }
    void poll();
    const timer = setInterval(poll, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function clearCache() {
    setClearing(true);
    try {
      await relay.clearCache();
      setStatus("Cache cleared. Buzz will load channels and media as needed.");
    } catch (error) {
      setStatus(`Buzz couldn’t clear the cache. ${String(error)}`);
    } finally {
      setClearing(false);
    }
  }

  return (
    <section aria-labelledby="developer-settings-title">
      <Header
        id="developer-settings-title"
        title="Developer"
        subtitle="View local development diagnostics. This section appears only in development builds served from localhost."
      />
      <div className="grid gap-6">
        <div className="space-y-2">
          <InlineHeader title="Runtime settings" />
          <PreferenceRow
            title="Log level"
            subtitle="Applies immediately and survives restarts of this worktree. Browser relay diagnostics use the same level."
            trailing={
              <Select
                label="Log level"
                variant="compact"
                value={level}
                disabled={!settingsReady || saving}
                onValueChange={(value) => void saveLevel(value)}
                groups={[
                  {
                    label: "",
                    options: Object.keys(LOG_LEVELS).map((value) => ({
                      value,
                      label: value.charAt(0).toUpperCase() + value.slice(1),
                    })),
                  },
                ]}
              />
            }
          />
          <p className="m-0 text-body-sm text-subtle">
            Info shows lifecycle messages; Debug shows every broker HTTP request
            and relay WebSocket frame; Trace adds safe protocol metadata.
            Message bodies and credentials are never included.
          </p>
          {settingsError && (
            <p role="alert" className="m-0 text-body-sm text-muted">
              {settingsError}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <InlineHeader title="Relay broker stats" />
          {stats ? (
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 text-body-sm">
              <div>
                <dt className="text-muted">Queries</dt>
                <dd className="m-0 tabular-nums">{stats.queries}</dd>
              </div>
              <div>
                <dt className="text-muted">Errors</dt>
                <dd className="m-0 tabular-nums">{stats.errors}</dd>
              </div>
              <div>
                <dt className="text-muted">Media</dt>
                <dd className="m-0 tabular-nums">{stats.media}</dd>
              </div>
              <div>
                <dt className="text-muted">Connects</dt>
                <dd className="m-0 tabular-nums">{stats.connects}</dd>
              </div>
            </dl>
          ) : (
            <p role="status" className="m-0 text-body-sm text-muted">
              Broker stats aren’t available. Start the development relay broker
              on this origin to view them.
            </p>
          )}
        </div>
        {clientMetrics.enabled && <ClientMetricsPanel />}
        <div className="space-y-2">
          <PreferenceRow
            title="Caches"
            subtitle="Clear cached channels, messages, and media. Buzz keeps your account, relay, and sidebar settings."
            trailing={
              <Button
                type="button"
                disabled={clearing}
                onClick={() => void clearCache()}
              >
                {clearing ? "Clearing…" : "Clear cache"}
              </Button>
            }
          />
          {status && (
            <p role="status" className="m-0 text-body-sm text-muted">
              {status}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
