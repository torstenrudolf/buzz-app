import { useEffectEvent } from "react";
import { useMessageEditScope } from "./MessageEditScope";
import { useMessageDeletion } from "./MessageManagement";
import { animate, useReducedMotion } from "motion/react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { SelectedMentionContext } from "./selected-mention-context";
import { DraftMentionRoster } from "./draft-mention-roster";
import {
  archivedMention,
  mentionCandidates,
  rememberMention,
} from "./mention-candidates";
import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "./composer-document";
import { useMessageEdit, lastEditableMessage } from "./useMessageEdit";
import { npubEncode } from "nostr-tools/nip19";
import type { ChannelMessage } from "../relay/contracts";
import { useFileDrop } from "./use-file-drop";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useNonmemberMentions } from "./useNonmemberMentions";
import { knownAgentPubkeys } from "../agents/known";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { rememberAgentsPreference } from "./mention-preferences";
import { SessionAgentControl } from "../sessions/SessionAgentControl";
import { sessionRecipients } from "../sessions/recipients";
import { TypingIndicator } from "./TypingIndicator";
import {
  ArrowUpIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { ComposerAttachments } from "./ComposerAttachments";
import { useAttachmentDraft } from "./attachment-draft";
import {
  useContext,
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import styles from "./Messages.module.css";
import { messageViewKey } from "./view-key";
import { isEmojiOnly, usesLargeEmojiPresentation } from "./emoji-size";
import {
  mentionDraft,
  followupDraft,
  type MentionDraft,
  type MentionRecipient,
} from "./mention-draft";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import { ComposerTools } from "../conversation/ComposerTools";
import { ComposerLinkDialog } from "./ComposerLinkDialog";
import { ComposerFormattingTools } from "./ComposerFormattingTools";
import type {
  ConversationExtensions,
  CompletionEdit,
  CompletionQuery,
  ComposerObservation,
} from "../conversation/contracts";
import { ComposerCompletions } from "../conversation/ComposerCompletions";
import { useCompletionEditor } from "../conversation/useCompletionEditor";
import { formatMediaTime, mediaTimeReply } from "./media-timecode";
import { RichComposerInput } from "./RichComposerInput";
import { composerMarkdown } from "./composer-markdown";
import type {
  ComposerInputElement,
  ComposerLinkEdit,
  ComposerFormat,
} from "./composer-dom";

const noChannels: ReturnType<RelaySession["channels"]["list"]> = {
  status: "idle",
  channels: [],
};
const noChannelSnapshot = () => noChannels;
const noChannelSubscription = () => () => {};

export type MessageComposerProps = {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  session: RelaySession;
  channelId: string;
  channelName: string;
  label?: string | undefined;
  placeholder?: string | undefined;
  sessionConversation?: boolean | undefined;
  trailingTool?: ReactNode;
  inviteAgents?: boolean | undefined;
  onSend?: (id: string) => void;
  /** Threads supply their own retained rows; channels use the shared window. */
  editMessages?: readonly ChannelMessage[] | undefined;
  onOpenLink?: ((target: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  threadRootId?: string;
  replyParentId?: string | undefined;
  replyContext?: ReactNode;
  mediaTimeSeconds?: number;
  clearMediaTime?(): void;
  /** Focus once when this conversation mounts, not when overlays close. */
  autoFocus?: boolean;
  focusRequest?: number;
  hideMediaTimeIndicator?: boolean;
  disabled?: boolean;
  /** A new conversation owns persistence and delivery before a channel exists. */
  submission?: {
    draftKey: string;
    initialDraft?: MentionDraft | string | undefined;
    /** A durable operation overrides disposable view state during recovery. */
    recoveredDraft?: MentionDraft | undefined;
    locked: boolean;
    disabled: boolean;
    submit: (draft: MentionDraft) => void;
  };
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function MessageComposer(props: MessageComposerProps) {
  return (
    <Composer
      key={`${props.submission?.draftKey ?? ""}:${messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.threadRootId,
      )}`}
      {...props}
    />
  );
}
function Composer({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  label: customLabel,
  placeholder,
  onSend,
  editMessages,
  onOpenLink,
  canOpenLink,
  threadRootId,
  replyParentId,
  replyContext,
  mediaTimeSeconds,
  clearMediaTime,
  autoFocus = false,
  focusRequest,
  hideMediaTimeIndicator = false,
  disabled: requestedDisabled = false,
  submission,
  sessionConversation,
  inviteAgents = false,
  trailingTool,
}: MessageComposerProps) {
  const list = useSyncExternalStore(
    session.channels?.get || sessionConversation
      ? session.channels.subscribeList
      : noChannelSubscription,
    session.channels?.get || sessionConversation
      ? session.channels.list
      : noChannelSnapshot,
    session.channels?.get || sessionConversation
      ? session.channels.list
      : noChannelSnapshot,
  );
  const readOnly =
    !submission &&
    !!session.channels?.get &&
    !list.channels.some(
      (channel) => channel.id === channelId && !channel.readOnly,
    );
  const cached = !!list.channels.find((channel) => channel.id === channelId)
    ?.cached;
  const disabled = requestedDisabled || readOnly;
  const [sending, setSending] = useState(false);
  const sendAttempt = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => sendAttempt.current?.abort(), []);
  useLayoutEffect(() => {
    if (disabled) sendAttempt.current?.abort();
  }, [disabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retargeting invalidates an in-flight send, not the root-keyed draft.
  useLayoutEffect(() => () => sendAttempt.current?.abort(), [replyParentId]);
  const inputId = useId();
  const draftKey =
    submission?.draftKey ??
    (threadRootId
      ? `draft:${channelId}:thread:${threadRootId}`
      : `draft:${channelId}`);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [admitting, setAdmitting] = useState(false);
  const admission = useRef(false);
  const live = useRef(true);
  const permitted = useRef(!disabled);
  permitted.current = !disabled;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const parentChannelId = list.channels.find(
    (item) => item.id === channelId,
  )?.parentChannelId;
  const mentionRoster = useContext(DraftMentionRoster);
  const agentChoices = inviteAgents || !!sessionConversation;
  const [value, updateDraft] = useState(() =>
    mentionDraft(
      submission?.recoveredDraft ??
        readView<unknown>(scope, draftKey, submission?.initialDraft ?? ""),
    ),
  );
  const draft = value.text;
  const valueRef = useRef(value);
  const caret = useRef<number | undefined>(undefined);
  const input = useRef<ComposerInputElement>(null);
  const focusOnMount = useRef(
    autoFocus && !disabled && typeof document !== "undefined"
      ? document.activeElement
      : undefined,
  );
  useEffect(() => {
    // A navigation/dialog owner may restore focus during this commit. Let that
    // explicit handoff win over the conversation's default initial focus.
    const previous = focusOnMount.current;
    if (
      previous &&
      (previous === document.activeElement ||
        (!previous.isConnected && document.activeElement === document.body))
    ) {
      const editor = input.current;
      if (!editor) return;
      const end = editor.value.length;
      editor.focus();
      editor.setSelectionRange(end, end);
      // Effect replay recreates the editor; retain this successful focus handoff.
      focusOnMount.current = editor;
    }
  }, []);
  const nonmembers = useNonmemberMentions(session, channelId, () =>
    input.current?.focus(),
  );
  useEffect(() => {
    if (focusRequest) input.current?.focus();
  }, [focusRequest]);
  const restoreSelection = useRef<{ start: number; end: number } | undefined>(
    undefined,
  );
  const [linkEdit, setLinkEdit] = useState<ComposerLinkEdit | null>(null);
  const [activeFormats, setActiveFormats] = useState<readonly ComposerFormat[]>(
    [],
  );
  const saveDraft = (next: MentionDraft) => {
    if (JSON.stringify(next) === JSON.stringify(valueRef.current)) return false;
    valueRef.current = next;
    updateDraft(next);
    if (!editing.target) writeView(scope, draftKey, next);
    return true;
  };
  const [error, setError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const focusRestoredDraft = useRef(false);
  const beforeEdit = useRef<
    { value: MentionDraft; restore(): void } | undefined
  >(undefined);
  const editing = useMessageEdit(session, () => {
    const saved = beforeEdit.current;
    if (!saved) return;
    valueRef.current = saved.value;
    updateDraft(saved.value);
    saved.restore();
    focusRestoredDraft.current = true;
    beforeEdit.current = undefined;
    setError(undefined);
    caret.current = undefined;
    setLinkEdit(null);
    completion.invalidate();
  });
  const editScope = useMessageEditScope();
  const editableRows = () =>
    editMessages ??
    editScope?.exactRows?.() ??
    (threadRootId
      ? []
      : (session.channels.window?.(channelId).rows ?? [])
    ).filter((row) => sessionConversation || !row.threadRootId);
  const editDisabled =
    disabled ||
    !!list.channels.find((channel) => channel.id === channelId)?.archived ||
    !!list.channels.find((channel) => channel.id === channelId)?.readOnly;
  const editingDisabled =
    disabled ||
    admitting ||
    sending ||
    !!submission?.locked ||
    (editing.target && (editing.locked || editDisabled)) ||
    false;
  const label = editing.target
    ? "Edit message"
    : (customLabel ??
      (threadRootId ? "Reply to thread" : `Message #${channelName}`));
  const attachments = useAttachmentDraft(
    session,
    `${scope}:${draftKey}`,
    channelId,
  );
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const canAttach = !submission && !!session.attachments;
  useEffect(() => {
    if (disabled) attachments.store.cancel();
  }, [disabled, attachments.store]);
  const dragging = useFileDrop(
    form,
    canAttach && !editingDisabled && !editing.target,
    attachFiles,
  );
  function attachFiles(files: readonly File[]) {
    if (editingDisabled || !files.length) return;
    if (editing.target) {
      setAttachmentError("Finish editing before attaching new files.");
      return;
    }
    if (!canAttach) {
      setAttachmentError(
        submission
          ? "Create this conversation before attaching files."
          : "Uploads are unavailable on this connection.",
      );
      return;
    }
    try {
      attachments.store.add(files);
      setAttachmentError(undefined);
    } catch (reason) {
      setAttachmentError(
        reason instanceof Error ? reason.message : "Could not attach files.",
      );
    }
  }
  const outbox = session.outbox;
  const emojiCatalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const largeEmojiDraft = usesLargeEmojiPresentation(
    draft,
    emojiCatalog.entries,
  );
  const completion = useCompletionEditor(
    input,
    !editingDisabled && !!outbox?.supports(9),
  );
  useEffect(() => {
    if (outbox?.supports(9)) void session.emoji.ensure();
  }, [session, outbox]);
  useLayoutEffect(() => {
    // Delivery closes while the input is still disabled. Focus only after React
    // has committed the restored, editable draft; preserve its saved selection.
    if (focusRestoredDraft.current) {
      focusRestoredDraft.current = false;
      input.current?.focus();
    }
    if (restoreSelection.current) {
      const { start, end } = restoreSelection.current;
      input.current?.focus();
      input.current?.setSelectionRange(start, end);
      restoreSelection.current = undefined;
      return;
    }
    if (caret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  });
  const requestDeletion = useMessageDeletion();
  const startEdit = useEffectEvent((row: ChannelMessage) => {
    if (editingDisabled || editDisabled || submission || !input.current) return;
    const current = editableRows().find((item) => item.id === row.id);
    if (!current || !lastEditableMessage(session, [current])) {
      setError("This message is no longer available to edit.");
      return;
    }
    if (editing.target) {
      setError("Finish or cancel your current edit first.");
      input.current.focus();
      return;
    }
    completion.invalidate();
    beforeEdit.current = {
      value: valueRef.current,
      restore: input.current.checkpoint(),
    };
    const next = mentionDraft(editing.start(current));
    valueRef.current = next;
    updateDraft(next);
    input.current.reset(next);
    setLinkEdit(null);
    caret.current = next.text.length;
    setError(undefined);
  });
  useEffect(() => {
    if (!editScope) return;
    const start = (row: ChannelMessage) => startEdit(row);
    editScope.current = start;
    editScope.input.current = input.current;
    return () => {
      if (editScope.current === start) {
        editScope.current = undefined;
        editScope.input.current = null;
      }
    };
  }, [editScope]);
  function insert(
    text: string,
    recipient?: MentionRecipient,
    range?: CompletionQuery,
  ) {
    if (
      editingDisabled ||
      !outbox?.supports(9) ||
      !input.current?.isConnected ||
      // DOM props are committed before child layout effects; closures can still
      // carry the preceding render's enabled state during that interval.
      input.current.disabled ||
      input.current.readOnly ||
      typeof text !== "string"
    )
      return false;
    // Edits replace prose; they do not change the original notification recipients.
    if (editing.target && recipient) {
      text = `nostr:${npubEncode(recipient.pubkey)} `;
      recipient = undefined;
    }
    if (
      recipient &&
      !mentionCandidates(session, channelId, agentChoices, mentionRoster, [
        recipient,
      ]).some((c) => c.recipient.pubkey === recipient.pubkey)
    ) {
      setError(
        "This recipient is no longer available. Remove it or refresh choices.",
      );
      return false;
    }
    if (recipient && valueRef.current.recipients.length >= 32) {
      setError("Choose at most 32 recipients");
      return false;
    }
    completion.invalidate();
    if (!input.current.insertText(text, recipient, range)) {
      setError("Message is too long to insert text");
      return false;
    }
    if (recipient) rememberMention(session, channelId, recipient.pubkey);
    setError(undefined);
    return true;
  }
  function insertMention(recipient: MentionRecipient) {
    if (
      !recipient ||
      typeof recipient.pubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(recipient.pubkey) ||
      typeof recipient.name !== "string" ||
      !recipient.name.trim()
    )
      return false;
    return insert(`@${recipient.name} `, recipient);
  }
  function replaceCompletion(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ) {
    if (
      !completion.valid(observation) ||
      valueRef.current.text !== observation.text
    )
      return false;
    if (key === " ") {
      const doc = readComposerSnapshot(valueRef.current.document);
      if (
        doc &&
        composerMarkdownContext(doc).protected.some(
          (r) => query.start < r.end && query.end > r.start,
        )
      )
        return false;
    }
    if ("mention" in edit && edit.mention)
      return insert(`@${edit.mention.name} `, edit.mention, query);
    return (
      typeof edit.text === "string" &&
      insert(
        `${edit.text}${isEmojiOnly(edit.text, emojiCatalog.entries) ? "" : " "}`,
        undefined,
        query,
      )
    );
  }
  const currentAdmission = () =>
    live.current &&
    permitted.current &&
    !sendAttempt.current?.signal.aborted &&
    session.channels.list().channels.find((item) => item.id === channelId)
      ?.parentChannelId === parentChannelId;
  async function prepareRecipients(explicit: readonly string[]) {
    const channel = await session.workSessions.refreshMembership(channelId);
    if (!currentAdmission())
      throw new Error("The session changed. Review its channel and retry.");
    const recipients = [
      ...sessionRecipients(
        channel,
        session.profiles.snapshot(),
        session.agentChoices.snapshot(),
        session.viewer,
        explicit,
      ),
    ];
    const missing = recipients.filter((key) => !channel.members?.includes(key));
    if (missing.length) {
      await session.agentChoices.refresh();
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
      await session.workSessions.addAgents(
        channelId,
        missing,
        currentAdmission,
      );
      if (!currentAdmission())
        throw new Error("The session changed. Review its channel and retry.");
    }
    return recipients;
  }
  function selectAgent(key: string) {
    if (disabled || admission.current) return;
    setSelectedAgent(key);
    setError(undefined);
  }
  async function send() {
    if (editing.target) {
      if (editDisabled || editing.locked) return;
      if (!valueRef.current.text.trim()) {
        if (editing.target.attachments.length) {
          setError(
            "Keep attachment links unchanged. To remove this message, use Delete message.",
          );
          return;
        }
        if (requestDeletion && session.outbox?.supports(5))
          requestDeletion(editing.target, editing.close);
        return;
      }
      editing.save(
        composerMarkdown(valueRef.current),
        editableRows().find((row) => row.id === editing.target?.id),
      );
      return;
    }
    if (
      disabled ||
      admission.current ||
      submission?.disabled ||
      (!submission && (input.current?.readOnly || input.current?.disabled)) ||
      (!draft.trim() && !attachments.items.length) ||
      attachments.blocked ||
      sendAttempt.current ||
      !outbox
    )
      return;
    const attempt = new AbortController();
    sendAttempt.current = attempt;
    const captured = valueRef.current;
    const capturedAttachments = attachments.store.snapshot();
    try {
      if (captured.recipients.some((p) => archivedMention(session, p.pubkey)))
        throw new Error(
          "A selected recipient is archived. Remove it before sending.",
        );
      if (submission) {
        submission.submit(captured);
        return;
      }
      let references: readonly string[] = [];
      let recipients = captured.recipients.length
        ? captured.recipients.map((item) => item.pubkey)
        : selectedAgent
          ? [selectedAgent]
          : [];
      if (sessionConversation) {
        admission.current = true;
        setAdmitting(true);
        recipients = await prepareRecipients(recipients);
      } else if (recipients.length) {
        const channel = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (
          (channel?.channelType === "stream" ||
            channel?.channelType === "forum") &&
          channel.members
        ) {
          const missing = captured.recipients.filter(
            (person) => !channel.members?.includes(person.pubkey),
          );
          if (missing.length) {
            setSending(true);
            setError(undefined);
            const decision = await nonmembers.prepare(
              missing,
              attempt.signal,
              () =>
                valueRef.current === captured &&
                attachments.store.snapshot() === capturedAttachments &&
                permitted.current,
            );
            if (decision === null) return;
            references = decision;
            recipients = recipients.filter((key) => !references.includes(key));
          }
        }
      }
      attempt.signal.throwIfAborted();
      if (
        valueRef.current !== captured ||
        attachments.store.snapshot() !== capturedAttachments
      )
        return;
      const content =
        threadRootId && mediaTimeSeconds !== undefined
          ? mediaTimeReply(mediaTimeSeconds, composerMarkdown(captured))
          : composerMarkdown(captured);
      const uploaded = capturedAttachments.flatMap((item) =>
        item.uploaded ? [item.uploaded] : [],
      );
      const id = threadRootId
        ? session.messages.reply(
            channelId,
            threadRootId,
            content,
            recipients,
            uploaded,
            ...(replyParentId || references.length ? [replyParentId] : []),
            ...(references.length ? [references] : []),
          )
        : references.length
          ? session.messages.send(
              channelId,
              content,
              recipients,
              uploaded,
              undefined,
              references,
            )
          : session.messages.send(channelId, content, recipients, uploaded);
      attachments.store.clear();
      onSend?.(id);
      completion.invalidate();
      clearMediaTime?.();
      const agents = knownAgentPubkeys(
        session.profiles.snapshot(),
        session.agentChoices.snapshot(),
      );
      const next = followupDraft(
        rememberAgentsPreference()
          ? captured.recipients.filter(
              (item) =>
                agents.has(item.pubkey) &&
                mentionCandidates(
                  session,
                  channelId,
                  agentChoices,
                  mentionRoster,
                ).some((c) => c.recipient.pubkey === item.pubkey),
            )
          : [],
      );
      const changed = saveDraft(next);
      // An unchanged prefill may not render. Do not leave a caret command for
      // the next keystroke to consume after inserting its first character.
      caret.current = changed ? next.text.length : undefined;
      input.current?.reset(next);
      input.current?.focus();
      if (!changed)
        input.current?.setSelectionRange(next.text.length, next.text.length);
      setError(undefined);
    } catch (reason) {
      if (live.current && !attempt.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      admission.current = false;
      if (sendAttempt.current === attempt) {
        sendAttempt.current = null;
        if (live.current) {
          setSending(false);
          setAdmitting(false);
        }
      }
    }
  }
  const accessories = extensions?.accessories && (
    <ComposerAccessories
      registry={extensions.accessories}
      session={session}
      scope={scope}
      channelId={channelId}
      threadRootId={threadRootId}
      canOpen={(target) => canOpenLink?.(target) ?? false}
      open={(target) => onOpenLink?.(target) ?? false}
    />
  );
  const renderLeadingTools = (tools: ReactNode) => (
    <>
      <div className={styles.composerLeadingTools}>
        {tools}
        {!!value.recipients.length && (
          <RecipientAvatars
            session={session}
            recipients={value.recipients}
            disabled={editingDisabled}
            remove={(pubkey) => input.current?.removeRecipient(pubkey)}
          />
        )}
      </div>
      {canAttach && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose attachments"
            onChange={(event) => {
              attachFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          <IconButton
            size="sm"
            type="button"
            aria-label="Attach files"
            title="Attach files"
            disabled={editingDisabled || !!editing.target}
            onClick={() => picker.current?.click()}
            icon={<PaperclipIcon size={16} />}
          />
        </>
      )}
    </>
  );
  if (!outbox?.supports(9) && !cached)
    return (
      <>
        {accessories}
        <footer className={styles.composer}>
          <TypingIndicator
            session={session}
            channelId={channelId}
            threadRootId={threadRootId}
          />
          This relay connection supports reading only.
        </footer>
      </>
    );
  return (
    <SelectedMentionContext.Provider value={value.recipients}>
      {accessories}
      {nonmembers.dialog}
      <form
        ref={form}
        className={styles.composer}
        data-file-drag={dragging || undefined}
        data-editing={!!editing.target || undefined}
        onKeyDown={(event) => {
          if (
            editing.target &&
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !completion.composing.current
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (!editing.busy) editing.close();
          }
        }}
        onPasteCapture={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          attachFiles(files);
        }}
        aria-label={
          editing.target
            ? "Edit message"
            : threadRootId
              ? "Reply to thread"
              : `Send a message to ${channelName}`
        }
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {editing.target && (
          <div className={styles.composerEditHeader}>
            <PencilSimpleIcon size={18} />
            <span>Editing message</span>
            <IconButton
              type="button"
              size="sm"
              aria-label={editing.locked ? "Close edit" : "Cancel edit"}
              disabled={editing.busy}
              onClick={editing.close}
              icon={<XIcon size={18} />}
            />
          </div>
        )}
        {!disabled && !submission && !editing.target && (
          <TypingIndicator
            session={session}
            channelId={channelId}
            threadRootId={threadRootId}
          />
        )}
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        {extensions?.completions && (
          <ComposerCompletions
            registry={extensions.completions}
            editor={completion}
            input={input}
            session={session}
            scope={scope}
            channelId={channelId}
            threadRootId={threadRootId}
            inviteAgents={agentChoices && !editing.target}
            replace={replaceCompletion}
            resolved={value}
          />
        )}
        {dragging && <p role="status">Drop files to attach</p>}
        {attachmentError && (
          <ToastNotice
            title="Could not attach file"
            description={attachmentError}
            onDismiss={() => setAttachmentError(undefined)}
          />
        )}
        <div className={styles.composerContent}>
          {!editing.target && (
            <ComposerAttachments
              media={session.media}
              items={attachments.items}
              disabled={editingDisabled}
              remove={attachments.store.remove}
              retry={attachments.store.retry}
            />
          )}
          <div className={styles.composerInput}>
            <RichComposerInput
              inviteAgents={agentChoices}
              ref={input}
              id={inputId}
              disabled={editingDisabled}
              value={draft}
              draft={value}
              session={session}
              scope={scope}
              channelId={channelId}
              extensions={extensions}
              emoji={emojiCatalog.entries}
              onDraftChange={(next) => {
                saveDraft(next);
                completion.observe(true);
              }}
              onFormatsChange={setActiveFormats}
              onEditLink={setLinkEdit}
              data-single-emoji={largeEmojiDraft || undefined}
              maxLength={16000}
              aria-label={label}
              placeholder={placeholder ?? label}
              onFocus={() => completion.observe(true)}
              onBlur={() => {
                completion.invalidate();
              }}
              onSelect={() => {
                completion.observe();
              }}
              onCompositionStart={() => {
                completion.composing.current = true;
                completion.invalidate();
              }}
              onCompositionEnd={() => {
                completion.composing.current = false;
                completion.observe(true);
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  completion.composing.current
                )
                  return;
                if (
                  event.shiftKey &&
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  completion.invalidate();
                  return;
                }
                if (completion.keys.current?.(event)) return;
                if (
                  event.key === "ArrowUp" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.repeat &&
                  !event.defaultPrevented &&
                  !editingDisabled &&
                  !editDisabled &&
                  !submission &&
                  !editing.target &&
                  event.currentTarget.value === "" &&
                  !valueRef.current.recipients.length &&
                  !attachments.items.length
                ) {
                  const target = lastEditableMessage(session, editableRows());
                  if (target) {
                    event.preventDefault();
                    startEdit(target);
                  }
                  return;
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  event.preventDefault();
                  if (!event.repeat || !editing.target) send();
                }
              }}
            />
          </div>
        </div>
        {!editing.target && replyContext}
        {!editing.target &&
          threadRootId &&
          mediaTimeSeconds !== undefined &&
          !hideMediaTimeIndicator && (
            <div className={styles.mediaComposerAnchor}>
              <span>Commenting at {formatMediaTime(mediaTimeSeconds)}</span>
              <IconButton
                size="compact"
                type="button"
                onClick={clearMediaTime}
                aria-label="Remove video time"
                icon={<XIcon size={13} />}
              />
            </div>
          )}
        <div className={styles.composerActions}>
          <ComposerFormattingTools
            disabled={editingDisabled}
            activeFormats={activeFormats}
            toggleFormat={(format) => input.current?.toggleFormat(format)}
            editLink={() => {
              const edit = input.current?.editLink();
              if (edit) setLinkEdit(edit);
            }}
          >
            {extensions ? (
              <ComposerTools
                registry={extensions.tools}
                renderLeading={renderLeadingTools}
                session={session}
                scope={scope}
                channelId={channelId}
                threadRootId={threadRootId}
                disabled={editingDisabled}
                inviteAgents={agentChoices && !editing.target}
                insertText={(text) => insert(text)}
                insertMention={insertMention}
                focus={() => input.current?.focus()}
              />
            ) : (
              renderLeadingTools(null)
            )}
          </ComposerFormattingTools>
          {!editing.target &&
            (trailingTool ??
              (sessionConversation ? (
                <SessionAgentControl
                  session={session}
                  channelId={channelId}
                  value={selectedAgent}
                  onChange={selectAgent}
                  disabled={editingDisabled}
                />
              ) : null))}
          <IconButton
            variant={
              draft.trim() || attachments.items.length ? "primary" : "ghost"
            }
            size="toolbar"
            shape="round"
            type="submit"
            aria-label={editing.target ? "Save changes" : "Send message"}
            title={editing.target ? "Save changes" : "Send message"}
            disabled={
              disabled ||
              (!!editing.target && (editing.locked || editDisabled)) ||
              admitting ||
              sending ||
              submission?.disabled ||
              (!editing.target && attachments.blocked) ||
              (!draft.trim() &&
                !attachments.items.length &&
                !(
                  editing.target &&
                  requestDeletion &&
                  session.outbox?.supports(5)
                ))
            }
            icon={<ArrowUpIcon size={16} />}
          />
        </div>
        {(error || editing.error) && (
          <p role="alert">{error ?? editing.error}</p>
        )}
        {editing.retryable && (
          <>
            <p role="status">Your edit is still in the outbox.</p>
            <Button
              type="button"
              disabled={editDisabled}
              onClick={editing.retry}
            >
              Retry edit
            </Button>
          </>
        )}
        {(error || editing.error) && emojiCatalog.status === "error" && (
          <Button
            type="button"
            disabled={editingDisabled}
            onClick={() => {
              void session.emoji.refresh().then(() => {
                if (
                  input.current?.isConnected &&
                  session.emoji.snapshot().status === "ready"
                ) {
                  setError(undefined);
                  editing.clearError();
                }
              });
            }}
          >
            Retry message preparation
          </Button>
        )}
      </form>
      {linkEdit && (
        <ComposerLinkDialog
          edit={linkEdit}
          input={input}
          disabled={editingDisabled}
          close={() => setLinkEdit(null)}
        />
      )}
    </SelectedMentionContext.Provider>
  );
}

/** Presentation stays host-owned even when the optional mention tool is disabled. */
function RecipientAvatars({
  session,
  recipients,
  disabled,
  remove,
}: {
  session: RelaySession;
  recipients: readonly MentionRecipient[];
  disabled: boolean;
  remove(pubkey: string): void;
}) {
  const reduceMotion = useReducedMotion();
  const enter = useCallback(
    (node: HTMLButtonElement | null) => {
      if (
        !node ||
        document.documentElement.hasAttribute("data-keyboard-navigation") ||
        reduceMotion
      )
        return;
      const animation = animate(
        node,
        { transform: ["scale(0.9)", "scale(1)"] },
        { type: "spring", duration: 0.24, bounce: 0.15 },
      );
      return () => animation.stop();
    },
    [reduceMotion],
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const unique = [
    ...new Map(recipients.map((item) => [item.pubkey, item])).values(),
  ];
  return (
    <section
      className={styles.mentionRecipients}
      aria-label="Explicit mentions"
    >
      {unique.map((recipient) => {
        const profile = profiles.get(recipient.pubkey);
        return (
          <IconButton
            key={recipient.pubkey}
            type="button"
            size="toolbar"
            ref={enter}
            data-mention-recipient=""
            data-avatar-shape={
              agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
            }
            title={`Remove explicit mention of ${recipient.name} (${recipient.pubkey.slice(0, 8)})`}
            aria-label={`Remove mention ${recipient.name} ${recipient.pubkey}`}
            disabled={disabled}
            onClick={() => remove(recipient.pubkey)}
            icon={
              <span
                className={styles.mentionRecipientArtwork}
                data-avatar-shape={
                  agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                }
                aria-hidden="true"
              >
                <Avatar
                  alt=""
                  fallback={recipient.name}
                  src={session.media(profile?.picture ?? "", "small")}
                  size="small"
                  shape={
                    agentPubkeys.has(recipient.pubkey) ? "squircle" : "circle"
                  }
                />
                <span className={styles.mentionRecipientRemove}>
                  <XIcon size={16} />
                </span>
              </span>
            }
          />
        );
      })}
    </section>
  );
}
