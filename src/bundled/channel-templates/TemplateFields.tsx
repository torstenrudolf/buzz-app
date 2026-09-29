import type { RelaySession } from "../../features/relay/session";
import { AgentOwnerPreview } from "../../features/profiles/AgentOwnerPreview";
import { npubEncode } from "nostr-tools/nip19";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { IdentityRow } from "../../shared/identity/IdentityRow";
import { useState } from "react";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  resolveLineup,
  type AgentChoice,
  type KitEntry,
  type Lineup,
} from "../../features/channel-templates/model";
import styles from "../channels/ChannelTemplates.module.css";

export function AgentSelection({
  session,
  selected,
  agents,
  onChange,
}: {
  session?: RelaySession | undefined;
  selected: readonly string[];
  agents: readonly AgentChoice[];
  onChange(keys: string[]): void;
}) {
  const [search, setSearch] = useState("");
  const choices: readonly AgentChoice[] = [
    ...agents,
    ...selected
      .filter((key) => !agents.some((a) => a.pubkey === key))
      .map((pubkey) => ({ pubkey, name: "Unavailable agent" })),
  ];
  const labels = publicKeyLabels(choices.map((agent) => agent.pubkey));
  return (
    <div className={styles.stack}>
      <Field label="Find individual agents">
        <Input
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or npub"
        />
      </Field>
      <div className={styles.choices}>
        {choices
          .filter((a) =>
            `${a.name} ${npubEncode(a.pubkey)} ${a.pubkey}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((agent) => (
            <IdentityRow
              key={agent.pubkey}
              pubkey={agent.pubkey}
              name={agent.name}
              picture={agent.avatar}
              isAgent
              previewDetail={
                session ? (
                  <AgentOwnerPreview session={session} pubkey={agent.pubkey} />
                ) : undefined
              }
              keyLabel={labels.get(agent.pubkey)}
              render={(content, previewProps) => (
                <Checkbox
                  {...previewProps}
                  label={content}
                  checked={selected.includes(agent.pubkey)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...selected, agent.pubkey]
                        : selected.filter((key) => key !== agent.pubkey),
                    )
                  }
                />
              )}
            />
          ))}
        {!choices.length && (
          <p className="text-secondary">
            No agents from the Agents page are available in this community.
          </p>
        )}
      </div>
    </div>
  );
}

export function TemplateFields({
  session,
  value,
  onChange,
  entries,
  agents,
  acceptedAgents,
}: {
  session?: RelaySession | undefined;
  value: Lineup;
  onChange(value: Lineup): void;
  acceptedAgents?: readonly string[] | undefined;
  entries: readonly KitEntry[];
  agents: readonly AgentChoice[];
}) {
  const teams = entries.flatMap((e) =>
    !e.record.deleted && e.record.value.type === "team" ? [e.record.value] : [],
  );
  const missing = value.teamIds.filter((id) => !teams.some((t) => t.id === id));
  const labels = publicKeyLabels([
    ...agents.map((agent) => agent.pubkey),
    ...(acceptedAgents ?? []),
  ]);
  let preview = "",
    error = "";
  try {
    preview =
      (acceptedAgents
        ? acceptedAgents.map((pubkey) => ({
            pubkey,
            name:
              agents.find((a) => a.pubkey === pubkey)?.name ??
              "Unavailable agent",
          }))
        : resolveLineup(value, entries, agents)
      )
        .map((a) => `${a.name} · ${labels.get(a.pubkey)}`)
        .join(", ") || "Only you";
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  return (
    <div className={styles.stack}>
      <fieldset className={styles.selections}>
        <legend>Saved teams</legend>
        {[
          ...teams,
          ...missing.map((id) => ({
            id,
            name: "Unavailable team",
            agents: [],
          })),
        ].map((team) => (
          <Checkbox
            key={team.id}
            label={`${team.name} (${team.agents.length})`}
            checked={value.teamIds.includes(team.id)}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                teamIds: checked
                  ? [...value.teamIds, team.id]
                  : value.teamIds.filter((id) => id !== team.id),
              })
            }
          />
        ))}
        {!teams.length && !missing.length && (
          <p className="text-secondary">
            Create reusable teams in Templates & teams.
          </p>
        )}
      </fieldset>
      <AgentSelection
        session={session}
        selected={value.agents}
        agents={agents}
        onChange={(agents) => onChange({ ...value, agents })}
      />
      <p className="text-secondary">
        Access preview: {preview}. Existing identities only; this does not start
        agents or send a message.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <Field label="Starting Canvas (Markdown)">
        <Textarea
          rows={8}
          value={value.canvas}
          onChange={(e) => onChange({ ...value, canvas: e.target.value })}
          placeholder={"# Goal\n\n# Scope\n\n# Success criteria"}
        />
      </Field>
    </div>
  );
}
