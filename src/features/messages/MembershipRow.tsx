import type { IdentityNameView } from "../identity-names/service";
import { useIdentityNames } from "../identity-names/react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { memo } from "react";
import type { Profile } from "../relay/contracts";
import { membershipDescription, type TimelineRow } from "./membership-rows";
import styles from "./Messages.module.css";

/** Quiet, non-conversational activity. Avatars are decorative; prose owns the label. */
export const MembershipRow = memo(function MembershipRow({
  row,
  names,
  profiles,
  viewer,
  media,
  agentPubkeys,
  day,
  resolveName: scopedName,
}: {
  row: TimelineRow;
  names?: IdentityNameView | undefined;
  profiles: ReadonlyMap<string, Profile>;
  viewer?: string | undefined;
  media(url: string, size?: "small"): string | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  day: boolean;
  resolveName?: (pubkey: string, fallback: string) => string;
}) {
  const globalName = useIdentityNames(names);
  const resolveName = scopedName ?? globalName;
  const { targets, text, title } = membershipDescription(
    row.membershipRows ?? [row],
    profiles,
    viewer,
    resolveName,
  );
  return (
    <div data-message-id={row.id} data-membership-row="">
      {day && (
        <div className={styles.day}>
          <span>
            {new Date(row.createdAt * 1000).toLocaleDateString(undefined, {
              year: "numeric",
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
      )}
      <div className={styles.membership}>
        <span className={styles.membershipAvatars} aria-hidden="true">
          {targets.slice(0, 3).map((id) => {
            const profile = profiles.get(id);
            const name = resolveName(id, profile?.name ?? id.slice(0, 10));
            const picture = profile?.picture
              ? media(profile.picture, "small")
              : undefined;
            return (
              <span
                className={styles.membershipAvatar}
                data-avatar-shape={
                  agentPubkeys?.has(id) ? "squircle" : "circle"
                }
                key={id}
              >
                <Avatar
                  src={picture}
                  alt=""
                  fallback={name}
                  size="fill"
                  shape={agentPubkeys?.has(id) ? "squircle" : "circle"}
                />
              </span>
            );
          })}
          {targets.length > 3 && (
            <span className={styles.membershipAvatarCount}>
              +{targets.length - 3}
            </span>
          )}
        </span>
        <p title={title}>{text}</p>
      </div>
    </div>
  );
});
