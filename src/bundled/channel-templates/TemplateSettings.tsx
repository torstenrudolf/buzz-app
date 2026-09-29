import { useState } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useRelayConnection } from "../../features/relay/react";
import type { SaveTemplateProps } from "../../features/channel-templates/provider";
import type { Template } from "../../features/channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";
import { useTemplateCatalog } from "./useTemplateCatalog";

export function TemplateSettings({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section className="mt-8" aria-label="Templates and teams settings">
      <h3 className="text-label">Templates &amp; teams</h3>
      <p className="text-body-sm text-muted">
        Private reusable starting setups. Apply them with the existing channel +
        buttons; existing channels are never changed.
      </p>
      {connection.status === "ready" ? (
        <Library
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          active={active}
        />
      ) : (
        <p role="status">Choose a connected community to manage templates.</p>
      )}
    </section>
  );
}
function Library({
  session,
  active,
}: {
  session: RelaySession;
  active(): boolean;
}) {
  const catalog = useTemplateCatalog(session);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        disabled={
          !session.channelKit.available ||
          catalog.kit.status !== "ready" ||
          !catalog.agentsReady
        }
        onClick={() => {
          if (active()) setOpen(true);
        }}
      >
        Manage templates &amp; teams
      </Button>
      {(catalog.kit.status !== "ready" ||
        !catalog.agentsReady ||
        catalog.error) && (
        <p role="status">
          {catalog.kit.error ??
            catalog.error ??
            "Templates or agents are not ready."}{" "}
          <Button onClick={catalog.refresh}>Reload</Button>
        </p>
      )}
      {open && (
        <ChannelTemplatesDialog
          session={session}
          open={open}
          onOpenChange={setOpen}
          kit={session.channelKit}
          agents={catalog.agents}
          active={active}
        />
      )}
    </>
  );
}
export function SaveAsTemplate({
  session,
  channel,
  active,
}: SaveTemplateProps) {
  const catalog = useTemplateCatalog(session);
  const [draft, setDraft] = useState<Template>();
  const [copyWarning, setCopyWarning] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        disabled={busy || !session.channelKit.available || !catalog.agentsReady}
        onClick={async () => {
          if (!active()) return;
          setBusy(true);
          setError("");
          try {
            const canvas = await session.canvas.read(channel.id);
            if (!active()) return;
            setCopyWarning(
              catalog.agentsComplete
                ? undefined
                : "Incomplete agent inventory: this copy includes only currently known agents and may omit others in the channel. Review the lineup before saving; reload agents and copy again for a complete snapshot.",
            );
            setDraft({
              type: "template",
              id: crypto.randomUUID(),
              name: channel.name,
              description: "",
              teamIds: [],
              agents: catalog.agents
                .filter((a) => channel.members?.includes(a.pubkey))
                .map((a) => a.pubkey),
              canvas: canvas?.content ?? "",
            });
          } catch (error) {
            if (active()) setError(String(error));
          } finally {
            if (active()) setBusy(false);
          }
        }}
      >
        Save as template…
      </Button>
      {error && <p role="alert">{error}</p>}
      {draft && (
        <ChannelTemplatesDialog
          session={session}
          open
          onOpenChange={(open) => {
            if (!open) setDraft(undefined);
          }}
          kit={session.channelKit}
          agents={catalog.agents}
          initial={draft}
          notice={copyWarning}
          active={active}
        />
      )}
    </>
  );
}
