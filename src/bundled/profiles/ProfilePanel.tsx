import { useAgentOwnerEvidence } from "../../features/profiles/useAgentOwnerEvidence";
import { useAgentControlRefresh } from "../../features/agents/control-react";
import { UserStatusDisplay } from "../../features/user-status/StatusDisplay";
import {
  ProfilePublicMetadata,
  usePublicAgentMetadata,
} from "./ProfilePublicMetadata";
import { ProfileAgentActions } from "./ProfileAgentActions";
import { ProfileAgentArchive } from "./ProfileAgentArchive";
import { ProfileMemories } from "./ProfileMemories";
import { relayOrigin } from "../../features/communities/destination";
import type {
  AgentControl,
  AgentControlState,
  AgentLogTarget,
} from "../../features/agents/control";
import { ProfileHarnessLog } from "./ProfileHarnessLog";
import { ProfileInstances } from "./ProfileInstances";
import { ProfileAgentRuntime } from "./ProfileAgentRuntime";
import { ProfileRuntime, useRuntimeAgents } from "./ProfileRuntime";
import type { Navigation } from "../../features/navigation/controller";
import { ProfileChannels } from "./ProfileChannels";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import {
  PresenceIndicator,
  usePresenceStatus,
} from "../../features/presence/react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { Button } from "../../shared/design-system/ui/Button";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ProfileActivity } from "./ProfileActivity";
import type { PanelProps } from "../../features/panels/service";
import {
  profileAgentHint,
  profilePanelKey,
  profileTarget,
} from "../../features/profiles/target";
import { formatPublicKey } from "../../shared/identity/public-key";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ProfileAgentIdentity } from "./ProfileAgentIdentity";
import styles from "./Profiles.module.css";

const emptyState: AgentControlState = {
  status: "unavailable",
  data: null,
  busy: false,
  error: null,
};
const emptyControlSnapshot = () => emptyState;
const noSubscribe = () => () => {};

export function ProfilePanel({
  relay,
  target,
  context,
  navigation,
  control,
  instanceId,
  close,
  refreshControl = true,
}: PanelProps & {
  relay: RelayData;
  navigation?: Navigation;
  control?: AgentControl;
  instanceId?: string | undefined;
  /** An enclosing exact-instance panel already owns status refresh. */
  refreshControl?: boolean;
}) {
  const connection = useRelayConnection(relay);
  const pubkey = profilePanelKey(target);
  if (!pubkey) return <p>Unsupported profile.</p>;
  if (connection.status !== "ready")
    return <p>Connect to a community to view this profile.</p>;
  return (
    <ProfileDetails
      key={`${connection.scope}:${connection.generation}:${pubkey}:${instanceId ?? ""}`}
      refreshControl={refreshControl}
      session={connection.session}
      pubkey={pubkey}
      agentHint={profileAgentHint(target)}
      instanceId={instanceId}
      context={context}
      navigation={navigation}
      control={control}
      scope={connection.scope}
      viewer={connection.viewer}
      close={close}
    >
      {control && (
        <ProfileAgentActions
          control={control}
          relay={relay}
          pubkey={pubkey}
          instanceId={instanceId}
        />
      )}
    </ProfileDetails>
  );
}
function ProfileDetails({
  children,
  agentHint,
  refreshControl,
  session,
  pubkey,
  context,
  navigation,
  control,
  scope,
  viewer,
  instanceId,
  close,
}: {
  agentHint: boolean;
  instanceId?: string | undefined;
  refreshControl: boolean;
  children?: ReactNode;
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
  navigation: Navigation | undefined;
  control: AgentControl | undefined;
  scope: string | undefined;
  viewer: string | undefined;
  close(): void;
}) {
  useAgentControlRefresh(refreshControl ? control : undefined);
  const selection = useMemo(
    () => selectProfiles(session.profiles, [pubkey]),
    [session.profiles, pubkey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profile = profiles.get(pubkey);
  const openHarnesses = navigation
    ? () => navigation.open({ version: 1, kind: "settings", section: "agents" })
    : undefined;
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, retry] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const [logTarget, setLogTarget] = useState<AgentLogTarget | null>(null);
  const controlState = useSyncExternalStore(
    control?.subscribe ?? noSubscribe,
    control?.snapshot ?? emptyControlSnapshot,
    emptyControlSnapshot,
  );
  const [tab, setTab] = useState<"info" | "runtime" | "channels" | "memories">(
    "info",
  );
  const region = useRef<HTMLElement>(null);
  const messageAttempt = useRef<AbortController>(undefined);
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  useEffect(() => {
    region.current?.focus();
    // Target, viewer and community changes remount this view (see key above).
    return () => messageAttempt.current?.abort();
  }, []);
  // Each target/session owns this completion; shared data work remains session-owned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void session.profiles.ensure([pubkey]).then(
      () => {
        if (active) setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [session, pubkey, attempt]);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const presence = usePresenceStatus(session.presence, pubkey, true);
  const knownAgent = agentPubkeys.has(pubkey);
  // Navigation carries appearance, not the evidence used by private controls.
  const displayAgent = knownAgent || agentHint;
  const thinkingId = useId();
  const describeThinking =
    knownAgent && tab === "info" && presence !== "unknown";
  const ownership = useAgentOwnerEvidence(
    session,
    knownAgent ? pubkey : undefined,
    attempt,
  );
  const verifiedOwner = ownership.owner;
  const publicMetadata = usePublicAgentMetadata(
    session,
    pubkey,
    verifiedOwner,
    (status === "ready" || !!profile) && ownership.settled,
  );
  const isOwner = knownAgent && !!viewer && verifiedOwner === viewer;
  // Private local configuration needs both native custody and verified ownership.
  const {
    count: runtimeCount,
    agent: runtimeAgent,
    pending: runtimePending,
  } = useRuntimeAgents(control, scope, pubkey, instanceId);
  const canViewRuntime = isOwner && runtimeCount > 0;
  // The log requires an exact native record and ready ownership evidence;
  // other runtime admission remains owned by the existing profile flow.
  const logAuthorized =
    !!logTarget &&
    !!control?.readLog &&
    !!session.authorizeAgentLog &&
    canViewRuntime &&
    ownership.status === "ready" &&
    controlState.status === "ready" &&
    runtimeAgent?.id === logTarget.id &&
    runtimeAgent?.pubkey === logTarget.pubkey &&
    runtimeAgent?.relayUrl === logTarget.relayUrl;
  useEffect(() => {
    if (logTarget && !logAuthorized) setLogTarget(null);
  }, [logTarget, logAuthorized]);
  const selectedTab =
    (tab === "memories" && !isOwner) || (tab === "runtime" && !canViewRuntime)
      ? "info"
      : tab;
  useEffect(() => {
    if (!isOwner)
      setTab((current) => (current === "memories" ? "info" : current));
  }, [isOwner]);
  useEffect(() => {
    if (!canViewRuntime)
      setTab((current) => (current === "runtime" ? "info" : current));
  }, [canViewRuntime]);
  let communityOrigin: string | undefined;
  if (scope && viewer && scope.endsWith(`:${viewer}`)) {
    try {
      communityOrigin = relayOrigin(scope.slice(0, -(viewer.length + 1)));
    } catch {
      // This session has no usable navigation scope.
    }
  }
  const npub = profileTarget(pubkey)?.slice(6) ?? pubkey;
  const identityName = useChannelIdentityNames(session, context?.channelId);
  const name = identityName(
    pubkey,
    profile?.name ??
      (displayAgent ? "Unknown agent" : (formatPublicKey(pubkey) ?? pubkey)),
  );
  const picture = profile?.picture
    ? (session.media(profile.picture) ?? null)
    : null;
  // As in New message, a known agent needs this community's ready native control.
  const messageable = () =>
    !agentPubkeys.has(pubkey) ||
    session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.managed && agent.pubkey === pubkey);
  const canMessage =
    session.directMessages.available &&
    !!navigation &&
    !!viewer &&
    !!communityOrigin &&
    viewer !== pubkey &&
    messageable();
  async function openMessage() {
    if (
      messageAttempt.current ||
      !navigation ||
      !viewer ||
      !communityOrigin ||
      !messageable()
    )
      return;
    const controller = new AbortController();
    messageAttempt.current = controller;
    setOpeningMessage(true);
    setMessageError("");
    try {
      const channelId = await session.directMessages.open(
        [pubkey],
        controller.signal,
      );
      if (controller.signal.aborted) return;
      void navigation.open({
        version: 1,
        kind: "conversation",
        channelId,
        scope: { viewer, communityOrigin },
      });
    } catch (reason) {
      if (!controller.signal.aborted)
        setMessageError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      messageAttempt.current = undefined;
      if (!controller.signal.aborted) setOpeningMessage(false);
    }
  }
  const instances = control ? (
    <ProfileInstances
      errorHandledByHost={!!runtimeAgent}
      control={control}
      pubkey={pubkey}
      context={context}
      session={session}
      canOpenPrivate
      selectedId={instanceId}
      scope={scope}
      communityOrigin={communityOrigin}
      viewer={viewer}
      knownAgent={knownAgent}
    />
  ) : null;
  return (
    <section
      ref={region}
      data-buzz-ui=""
      aria-label="Profile details"
      aria-describedby={describeThinking ? thinkingId : undefined}
      tabIndex={-1}
      className={styles.root}
    >
      {logAuthorized && logTarget && control ? (
        <ProfileHarnessLog
          key={`${logTarget.id}:${logTarget.relayUrl}:${viewer}`}
          control={control}
          target={logTarget}
          name={name}
          onBack={() => {
            setLogTarget(null);
            region.current?.focus();
          }}
        />
      ) : (
        <>
          <div className={styles.identity}>
            <div className={styles.portrait}>
              <AgentAvatar
                session={session}
                agentPubkey={pubkey}
                channelId={context?.channelId}
                thinkingDescriptionId={
                  describeThinking ? thinkingId : undefined
                }
                src={picture}
                alt={
                  tab === "info" && presence !== "unknown"
                    ? ""
                    : `${name} avatar`
                }
                fallback={name}
                size="fill"
                shape={displayAgent ? "squircle" : "circle"}
                statusBadge={presence === "unknown" ? undefined : presence}
              />
            </div>
            <h2 className="text-heading">{name}</h2>
          </div>
          <Tabs
            value={selectedTab}
            onValueChange={setTab}
            items={[
              { value: "info", label: "Info" },
              ...(canViewRuntime
                ? [{ value: "runtime" as const, label: "Runtime" }]
                : []),
              { value: "channels", label: "Channels" },
              ...(isOwner
                ? [{ value: "memories" as const, label: "Memories" }]
                : []),
            ]}
            label="Profile sections"
            variant="panel"
            renderPanel={(selected) => (
              <div className={styles.tabContent}>
                {selected === "info" ? (
                  <>
                    <PresenceIndicator
                      presence={session.presence}
                      pubkey={pubkey}
                      profile
                    />
                    <UserStatusDisplay session={session} userId={pubkey} />
                    {canMessage && (
                      <div>
                        <Button
                          size="compact"
                          loading={openingMessage}
                          onClick={() => void openMessage()}
                        >
                          Message
                        </Button>
                        {messageError && <p role="alert">{messageError}</p>}
                      </div>
                    )}
                    {profile?.about && (
                      <p className={styles.about}>{profile.about}</p>
                    )}
                    {control && scope && (
                      <ProfileAgentRuntime
                        control={control}
                        onOpenHarnesses={openHarnesses}
                        scope={scope}
                        pubkey={pubkey}
                        instanceId={instanceId}
                        owned={isOwner}
                      />
                    )}
                    {children}
                    {knownAgent && (
                      <ProfileAgentArchive
                        session={session}
                        pubkey={pubkey}
                        control={control}
                        scope={scope}
                        onDeleted={close}
                      />
                    )}
                    {knownAgent && (
                      <ProfileActivity
                        session={session}
                        pubkey={pubkey}
                        context={context}
                      />
                    )}
                    {control &&
                      (!knownAgent || ownership.settled) &&
                      !runtimePending &&
                      !canViewRuntime && (
                        <ProfileInstances
                          errorHandledByHost
                          control={control}
                          pubkey={pubkey}
                          context={context}
                          session={session}
                          canOpenPrivate={verifiedOwner === viewer && !!viewer}
                          selectedId={instanceId}
                          scope={scope}
                          communityOrigin={communityOrigin}
                          viewer={viewer}
                          knownAgent={displayAgent}
                        />
                      )}
                    <div className={styles.publicKey}>
                      <div className={styles.keyHeading}>
                        <h3 className="text-body">Public key</h3>
                        <Button
                          size="compact"
                          variant="ghost"
                          aria-label="Copy npub"
                          onClick={() => {
                            setCopyStatus("");
                            void Promise.resolve()
                              .then(() => navigator.clipboard.writeText(npub))
                              .then(
                                () => setCopyStatus("Public key copied."),
                                () =>
                                  setCopyStatus(
                                    "Could not copy. Select the public key above to copy it.",
                                  ),
                              );
                          }}
                        >
                          <CopyIcon size={16} aria-hidden="true" />
                          Copy
                        </Button>
                      </div>
                      <code className="font-mono text-mono">{npub}</code>
                      <span role="status" className={styles.feedback}>
                        {copyStatus}
                      </span>
                    </div>
                    {knownAgent && verifiedOwner && (
                      <ProfileAgentIdentity
                        session={session}
                        owner={verifiedOwner}
                        viewer={viewer}
                        context={context}
                      />
                    )}
                    <ProfilePublicMetadata
                      key={verifiedOwner ?? "unowned"}
                      source={publicMetadata}
                      nip05={profile?.nip05}
                    />
                    {!profile &&
                      (status === "loading" ? (
                        <p role="status">Loading profile…</p>
                      ) : (
                        <p role={status === "error" ? "alert" : undefined}>
                          {status === "error"
                            ? "Could not load this profile."
                            : "No profile metadata is available in this community."}
                        </p>
                      ))}
                    {((!profile && status !== "loading") ||
                      publicMetadata.failed ||
                      ownership.failed) && (
                      <Button
                        size="compact"
                        onClick={() => {
                          retry((value) => value + 1);
                          publicMetadata.retry();
                        }}
                      >
                        Retry profile
                      </Button>
                    )}
                  </>
                ) : selected === "runtime" &&
                  canViewRuntime &&
                  control &&
                  verifiedOwner ? (
                  runtimeAgent ? (
                    <ProfileRuntime
                      control={control}
                      onOpenHarnesses={openHarnesses}
                      agent={runtimeAgent}
                      session={session}
                      owner={verifiedOwner}
                      instances={instances}
                      authorizeLog={
                        ownership.status === "ready"
                          ? session.authorizeAgentLog
                          : undefined
                      }
                      onOpenLog={setLogTarget}
                    />
                  ) : (
                    <div className={styles.runtimeTab}>{instances}</div>
                  )
                ) : selected === "memories" && isOwner ? (
                  <ProfileMemories session={session} pubkey={pubkey} />
                ) : (
                  <ProfileChannels
                    session={session}
                    pubkey={pubkey}
                    navigation={navigation}
                    communityOrigin={communityOrigin}
                    viewer={viewer}
                    control={control}
                    scope={scope}
                  />
                )}
              </div>
            )}
          />
        </>
      )}
    </section>
  );
}
