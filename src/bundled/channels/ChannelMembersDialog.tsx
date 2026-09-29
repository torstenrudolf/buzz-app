import { npubEncode } from "nostr-tools/nip19";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { AgentControl } from "../../features/agents/control";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { canAddMembers } from "../../features/channel-members/members";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { AgentOwnerPreview } from "../../features/profiles/AgentOwnerPreview";
import { IdentityRow } from "../../shared/identity/IdentityRow";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { UsersIcon } from "../../shared/design-system/icons";
import { useMemberSearch } from "./useMemberSearch";

export function ChannelMembersButton({
  session,
  channelId,
  control,
}: {
  session: RelaySession;
  channelId: string;
  control?: AgentControl | undefined;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        aria-label="Channel members"
        title="Channel members"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        icon={<UsersIcon size={19} aria-hidden="true" />}
      />
      {open && (
        <ChannelMembersDialog
          session={session}
          channelId={channelId}
          control={control}
          close={() => setOpen(false)}
          trigger={trigger}
        />
      )}
    </>
  );
}

/** Members are shared relay truth; only search and in-progress presentation belong to this dialog. */
export function ChannelMembersDialog({
  session,
  channelId,
  control,
  close,
  trigger,
}: {
  session: RelaySession;
  channelId: string;
  control?: AgentControl | undefined;
  close(): void;
  trigger: React.RefObject<HTMLButtonElement | null>;
}) {
  const input = useRef<HTMLElement>(null);
  const focusedAdd = useRef<{ key: string; button: HTMLButtonElement } | null>(
    null,
  );
  const lifetime = useRef<AbortController>(undefined);
  const [query, setQuery] = useState("");
  const additions = useSyncExternalStore(
    session.memberAdditions.subscribe,
    session.memberAdditions.snapshot,
    session.memberAdditions.snapshot,
  ).filter((item) => item.channelId === channelId);
  const busy = new Set(
    additions.filter((item) => item.pending).map((item) => item.pubkey),
  );
  const errors = Object.fromEntries(
    additions
      .filter((item) => item.error)
      .map((item) => [item.pubkey, item.error]),
  );
  const [notice, setNotice] = useState("");
  const [rosterError, setRosterError] = useState("");
  const [nameError, setNameError] = useState("");
  const [rosterBusy, setRosterBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [nameRefresh, setNameRefresh] = useState(0);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const agents = useAgentChoices(session);
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const canAdd = canAddMembers(session, channel);
  const search = useMemberSearch(session, query, canAdd);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      lifetime.current = undefined;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries the roster read.
  useEffect(() => {
    let current = true;
    setRosterBusy(true);
    setRosterError("");
    void session
      .read([{ kinds: [39002], "#d": [channelId], limit: 1 }], { fresh: true })
      .then(
        (events) => {
          if (
            current &&
            !events.some(
              (event) =>
                event.kind === 39002 &&
                event.tags.some(
                  ([tag, value]) => tag === "d" && value === channelId,
                ),
            )
          )
            setRosterError(
              "The member list could not be confirmed. Try again.",
            );
        },
        () => {
          if (current)
            setRosterError("The member list could not load. Try again.");
        },
      )
      .finally(() => {
        if (current) setRosterBusy(false);
      });
    void session.archives.ensure();
    return () => {
      current = false;
    };
  }, [session, channelId, refresh]);
  const memberKey = channel?.members?.join(":") ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: nameRefresh explicitly retries missing names.
  useEffect(() => {
    if (!memberKey) return;
    let current = true;
    setNameError("");
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setNameError(
            "Some names could not load. Public keys still identify members. Try again.",
          );
      });
    return () => {
      current = false;
    };
  }, [session, memberKey, nameRefresh]);
  const known = new Map(
    agents.identities.map((agent) => [agent.pubkey, agent]),
  );
  const members = new Set(channel?.members ?? []);
  const archived = new Set(archives.archived);
  const label = (key: string, fallback?: string) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        fallback ??
        formatPublicKey(key) ??
        "Unknown member",
    );
  const matches = (key: string, name: string) =>
    `${name} ${key} ${npubEncode(key)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const currentMembers = [...members]
    .filter((key) => matches(key, label(key)))
    .sort((a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b));
  const candidates = new Map(
    search.people.map((person) => [person.pubkey, person]),
  );
  if (query.trim())
    for (const agent of agents.identities) {
      if (matches(agent.pubkey, label(agent.pubkey, agent.name)))
        candidates.set(agent.pubkey, {
          pubkey: agent.pubkey,
          name: agent.name,
          isAgent: true,
        });
    }
  const available = [...candidates.values()].filter(
    (person) => !members.has(person.pubkey) && !archived.has(person.pubkey),
  );
  const keys = publicKeyLabels([...members, ...candidates.keys()]);
  // A confirmed addition replaces its focused Add button with a static member row.
  // DOM removal does not emit blur, so restore focus only if it was not moved elsewhere.
  useLayoutEffect(() => {
    const previous = focusedAdd.current;
    if (!previous || !memberKey.split(":").includes(previous.key)) return;
    focusedAdd.current = null;
    if (
      document.activeElement === previous.button ||
      document.activeElement === document.body
    )
      input.current?.focus();
  }, [memberKey]);
  const add = async (key: string) => {
    const signal = lifetime.current?.signal;
    if (!signal) return;
    setNotice("");
    try {
      await session.memberAdditions.add(channelId, key, control);
      if (!signal.aborted) setNotice(`${label(key)} is in the channel.`);
    } catch {
      // Session-owned recovery remains visible if this dialog closes and reopens.
    }
  };

  const row = (
    key: string,
    name: string,
    adding: boolean,
    picture?: string,
    agent?: boolean,
  ) => {
    const isAgent = agent || known.has(key) || profiles.get(key)?.isAgent;
    const artwork = picture ?? profiles.get(key)?.picture;
    const identity = (
      <IdentityRow
        pubkey={key}
        name={`${name}${key === session.viewer ? " (you)" : ""}`}
        picture={artwork ? session.media(artwork, "small") : undefined}
        isAgent={isAgent}
        keyLabel={keys.get(key)}
        previewDetail={
          isAgent ? (
            <AgentOwnerPreview session={session} pubkey={key} />
          ) : undefined
        }
        detail={archived.has(key) ? "Archived" : undefined}
        render={
          adding
            ? (content, previewProps) => (
                <NavigationItem
                  {...previewProps}
                  label={content}
                  trailing={busy.has(key) ? "Adding…" : "Add"}
                  aria-label={`Add ${name} (${npubEncode(key)})`}
                  aria-disabled={busy.has(key) || undefined}
                  disabled={rosterBusy || !!rosterError}
                  onBlur={(event) => {
                    if (focusedAdd.current?.button === event.currentTarget)
                      focusedAdd.current = null;
                  }}
                  onClick={(event) => {
                    if (busy.has(key)) return;
                    if (document.activeElement === event.currentTarget)
                      focusedAdd.current = { key, button: event.currentTarget };
                    void add(key);
                  }}
                />
              )
            : undefined
        }
      />
    );
    return adding ? (
      <div key={key}>{identity}</div>
    ) : (
      <li key={key} className="flex items-center px-control-inset py-2">
        {identity}
      </li>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Channel members"
      height="stable"
      description={channel?.name}
      closeLabel="Close channel members"
      initialFocus={input}
      finalFocus={trigger}
    >
      <div className="space-y-4">
        <SearchField
          inputRef={input}
          label="Search people and agents"
          placeholder={canAdd ? "Add people and agents" : "Search members"}
          value={query}
          onValueChange={setQuery}
          maxLength={256}
        />
        {!canAdd && (
          <p className="text-body-sm text-subtle">
            {channel?.channelType === "dm"
              ? "DM membership cannot be changed here."
              : channel?.archived
                ? "Archived channels cannot add members."
                : !session.outbox?.supports(9000)
                  ? "Adding members is unavailable in this connection."
                  : "Join this channel to add people and agents."}
          </p>
        )}
        {rosterBusy && !members.size && (
          <p role="status" className="text-body-sm text-subtle">
            Loading members…
          </p>
        )}
        {rosterError && (
          <p role="alert" className="text-body-sm text-danger">
            {rosterError}{" "}
            <Button onClick={() => setRefresh((value) => value + 1)}>
              Retry members
            </Button>
          </p>
        )}
        <div className="-mx-3 px-1 py-1 max-[480px]:-mx-1">
          <h3 className="px-control-inset pb-2 text-caption text-subtle">
            Members · {members.size}
          </h3>
          <ul>{currentMembers.map((key) => row(key, label(key), false))}</ul>
          {!currentMembers.length && !rosterBusy && (
            <p className="px-control-inset text-body-sm text-subtle">
              {query ? "No members match your search." : "No members to show."}
            </p>
          )}
          {canAdd && query.trim() && (
            <section className="mt-4" aria-label="Not in this channel">
              <h3 className="px-control-inset pb-2 text-caption text-subtle">
                Not in this channel
              </h3>
              {available.map((person) =>
                row(
                  person.pubkey,
                  label(person.pubkey, person.name),
                  true,
                  person.picture,
                  person.isAgent,
                ),
              )}
              {search.loading && (
                <p
                  role="status"
                  className="px-control-inset text-body-sm text-subtle"
                >
                  Searching…
                </p>
              )}
              {!search.loading && !search.error && !available.length && (
                <p className="px-control-inset text-body-sm text-subtle">
                  No other matching people or agents.
                </p>
              )}
              {search.error && (
                <p
                  role="alert"
                  className="px-control-inset text-body-sm text-danger"
                >
                  {search.error}{" "}
                  <Button onClick={search.retry}>Retry search</Button>
                </p>
              )}
              {search.more && (
                <Button onClick={search.next} disabled={search.loading}>
                  Show more results
                </Button>
              )}
            </section>
          )}
        </div>
        {nameError && (
          <p role="status" className="text-body-sm text-subtle">
            {nameError}{" "}
            <Button onClick={() => setNameRefresh((value) => value + 1)}>
              Retry names
            </Button>
          </p>
        )}
        {agents.error && (
          <p role="alert" className="text-body-sm text-danger">
            Some agents could not load.{" "}
            <Button onClick={() => void session.agentChoices.refresh()}>
              Retry agents
            </Button>
          </p>
        )}
        {archives.status === "error" && (
          <p role="alert" className="text-body-sm text-danger">
            Archived identities could not be checked.{" "}
            <Button onClick={() => void session.archives.refresh()}>
              Retry archive check
            </Button>
          </p>
        )}
        {Object.entries(errors).map(([key, error]) => (
          <p role="alert" key={key} className="text-body-sm text-danger">
            {label(key)}: {error}{" "}
            {!additions.find((item) => item.pubkey === key)?.removed && (
              <Button
                disabled={busy.has(key) || !canAdd}
                onClick={() => void add(key)}
              >
                {busy.has(key) ? "Retrying…" : "Retry"}
              </Button>
            )}
          </p>
        ))}
        {notice && (
          <p role="status" className="text-body-sm text-subtle">
            {notice}
          </p>
        )}
      </div>
    </Dialog>
  );
}
