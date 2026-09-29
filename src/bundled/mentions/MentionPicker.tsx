import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AtIcon } from "../../shared/design-system/icons/index";
import { useEffect, useId, useRef, useState } from "react";
import { useMentionChoices } from "./use-mention-choices";
import type { RelaySession } from "../../features/relay/session";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./Mentions.module.css";

import type { ComposerToolProps } from "../../features/conversation/contracts";

/** Select identities from the shared relay roster, never from display-name matching. */
export function MentionPicker({
  session,
  channelId,
  disabled,
  inviteAgents,
  select,
}: {
  session: RelaySession;
  scope: string;
  channelId: string;
  disabled: boolean;
  inviteAgents?: boolean | undefined;
  select: ComposerToolProps["insertMention"];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const accepted = useRef(false);
  const searchInput = useRef<HTMLElement>(null);
  // The picker stays mounted while closed; each opening is its own lifetime.
  const [opening, setOpening] = useState(0);
  const lifetime = `picker:${useId()}:${opening}`;
  const model = useMentionChoices(
    session,
    channelId,
    inviteAgents,
    search,
    lifetime,
    open && !disabled,
  );
  const {
    profiles,
    agents,
    list,
    channel,
    roster: draftRoster,
    choices: candidates,
  } = model;
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
  const members =
    draftRoster?.map((person) => person.pubkey) ?? channel?.members;
  const memberKey = members?.join(":") ?? "";
  useEffect(() => {
    if (draftRoster || !open || !memberKey) return;
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setError(
            "Names unavailable. Exact public keys still identify recipients.",
          );
      });
    return () => {
      current = false;
    };
  }, [session, open, memberKey, draftRoster]);
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setOpening((value) => value + 1);
          accepted.current = false;
          if (!draftRoster) session.channels.ensureList();
        }
      }}
    >
      <fieldset
        ref={controls}
        disabled={disabled}
        className={styles.pickerControls}
        aria-label="Mention controls"
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            <IconButton
              disabled={disabled}
              size="toolbar"
              ref={trigger}
              type="button"
              aria-label="Mention a member"
              title="Mention a member"
              icon={<AtIcon size={20} aria-hidden="true" />}
            />
          }
        />
        <PopoverPopup
          side="top"
          sideOffset={4}
          anchor={() => controls.current?.closest("form") ?? trigger.current}
          padding="none"
          initialFocus={searchInput}
          style={{
            width: 380,
            height: "min(360px, var(--available-height))",
            overflow: "hidden",
            display: "flex",
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const fromSearch = event.target === searchInput.current;
            if (event.key === "Enter" && fromSearch) event.preventDefault();
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
            const rows = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[data-mention-choice]:not(:disabled)",
              ),
            );
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (
                !fromSearch &&
                !rows.includes(event.target as HTMLButtonElement)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              const current = rows.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                current < 0
                  ? event.key === "ArrowDown"
                    ? 0
                    : rows.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      rows.length) %
                    rows.length;
              rows[next]?.focus();
            } else if (event.key === "Enter" && fromSearch) {
              event.stopPropagation();
              rows[0]?.click();
            }
          }}
          aria-label="Mention a member or agent"
          finalFocus={!accepted.current}
        >
          <div className={styles.mentionContent}>
            <SearchField
              variant="capsule"
              inputRef={searchInput}
              label={
                draftRoster
                  ? "Search recipients"
                  : inviteAgents
                    ? "Search members and agents"
                    : "Search community people and agents"
              }
              value={search}
              onValueChange={setSearch}
              disabled={disabled}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            {!draftRoster && inviteAgents && (
              <p>
                {parentAdmission
                  ? "Agents you mention join this session and its parent channel when you send, with access to their history."
                  : "Agents you mention join this session when you send, with access to its history."}
              </p>
            )}
            {model.directory.loading && (
              <p role="status">Searching community…</p>
            )}
            {model.directory.error && (
              <>
                <p role="status">{model.directory.error}</p>
                <Button type="button" onClick={model.directory.retry}>
                  Retry community search
                </Button>
              </>
            )}
            {agents.status === "loading" && !candidates.length && (
              <p role="status">Loading agents…</p>
            )}
            {(agents.status === "error" || !!agents.error) && (
              <Button
                type="button"
                onClick={() =>
                  void session.agentChoices.refresh(!!inviteAgents)
                }
              >
                Retry agent list
              </Button>
            )}
            {model.archives.status === "error" && (
              <Button
                type="button"
                onClick={() => void session.archives?.refresh()}
              >
                Retry archive information
              </Button>
            )}
            {error && <p role="status">{error}</p>}
            {!draftRoster && list.error && (
              <>
                <p role="alert">Could not refresh channel membership.</p>
                <Button
                  disabled={disabled}
                  type="button"
                  onClick={() => session.channels.refreshList?.()}
                >
                  Retry channel membership
                </Button>
              </>
            )}
            {!draftRoster && (!inviteAgents || !!channel) && !members && (
              <p role="status">Channel membership unavailable.</p>
            )}
            <div className={`${styles.mentionChoices} buzz-thin-scrollbar`}>
              {candidates.map(
                ({ recipient, label, agent, disabled: reason }) => (
                  <NavigationItem
                    variant="option"
                    data-mention-choice=""
                    type="button"
                    key={recipient.pubkey}
                    aria-label={`${label} ${recipient.pubkey}`}
                    disabled={disabled || !!reason}
                    onClick={() => {
                      if (
                        model.canSelect(recipient.pubkey) &&
                        select(recipient)
                      ) {
                        accepted.current = true;
                        setOpen(false);
                      }
                    }}
                    label={
                      <span className="flex flex-col whitespace-normal">
                        <span>{label}</span>
                        {reason && <small>{reason}</small>}
                        {!members?.includes(recipient.pubkey) && (
                          <small className="text-caption text-subtle">
                            {inviteAgents
                              ? parentAdmission
                                ? "Adds to session and parent channel when you send"
                                : "Adds to session when you send"
                              : "Not in channel · Choose whether to add when you send"}
                          </small>
                        )}
                      </span>
                    }
                    title={recipient.pubkey}
                    trailing={<code>{recipient.pubkey.slice(0, 12)}</code>}
                    icon={
                      <Avatar
                        alt=""
                        fallback={label}
                        src={session.media(
                          profiles.get(recipient.pubkey)?.picture ??
                            model.directory.people.find(
                              (person) => person.pubkey === recipient.pubkey,
                            )?.picture ??
                            "",
                          "small",
                        )}
                        size="large"
                        shape={
                          agent || !members?.includes(recipient.pubkey)
                            ? "squircle"
                            : "circle"
                        }
                      />
                    }
                  />
                ),
              )}
              {model.truncated && (
                <p>Narrow your search to see more members.</p>
              )}
              {members && !candidates.length && (
                <p>No matching channel members.</p>
              )}
            </div>
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
