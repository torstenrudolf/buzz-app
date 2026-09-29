import { useRelayConnection } from "../features/relay/react";
import { readChannelSidebarWidth } from "../bundled/channels/useSidebarView";
import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { Panel } from "../shared/design-system/ui/Panel";
import {
  ArrowLeftIcon,
  ChatCircleIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
} from "../shared/design-system/icons";
import channelStyles from "../bundled/channels/Channels.module.css";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import {
  appSettingsSections,
  developerMode,
  type SettingsSection,
} from "./Settings";
import styles from "./Settings.module.css";

export function SettingsSidebar({
  cards,
  communities,
  selected,
  onBack,
  onSection,
}: {
  cards: SettingsCards;
  communities: Communities;
  selected?: string;
  onBack: () => void;
  onSection: (section: string) => void;
}) {
  const connection = useRelayConnection(communities.relay);
  const width = readChannelSidebarWidth(connection.scope ?? "disconnected");
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  const communitySections: readonly SettingsSection[] = useMemo(
    () =>
      selectedCommunity
        ? [
            { id: "profile", label: "Profile", icon: UserIcon },
            ...contributed
              .filter((card) => !card.group && !card.section)
              .map((card) => ({
                id: card.key,
                label: card.title,
                icon: ChatCircleIcon,
              })),
          ]
        : [],
    [contributed, selectedCommunity],
  );
  const administrationSections: readonly SettingsSection[] = useMemo(
    () =>
      contributed
        .filter((card) => card.section === "administration")
        .map((card) => ({
          id: card.key,
          label: card.title,
          icon: UsersIcon,
        })),
    [contributed],
  );
  const contributedGroups = useMemo(
    () =>
      [...new Set(contributed.flatMap((card) => card.group ?? []))].map(
        (label) => ({
          label,
          sections: contributed
            .filter((card) => card.group === label)
            .map((card) => ({
              id: card.key,
              label: card.title,
              icon: ChatCircleIcon,
            })),
        }),
      ),
    [contributed],
  );
  const current = selected ?? (selectedCommunity ? "profile" : "appearance");
  const section = ({ id, label, icon: Icon }: SettingsSection) => (
    <NavigationItem
      key={id}
      label={label}
      icon={<Icon aria-hidden="true" size={18} />}
      selected={current === id}
      aria-current={current === id ? "page" : undefined}
      onClick={() => onSection(id)}
    />
  );

  return (
    <div className="shell-sidebar-default" style={{ width }}>
      <Panel as="aside" aria-label="Settings sidebar">
        <div className={`${channelStyles.sidebar} ${styles.settingsSidebar}`}>
          <NavigationItem
            label="Back"
            icon={<ArrowLeftIcon aria-hidden="true" size={18} />}
            onClick={onBack}
          />
          <nav
            aria-label="Settings sections"
            className={styles.settingsNavigation}
          >
            {selectedCommunity && (
              <SettingsGroup label={selectedCommunity.name}>
                {communitySections.map(section)}
              </SettingsGroup>
            )}
            {selectedCommunity && administrationSections.length > 0 && (
              <SettingsGroup label="Administration">
                {administrationSections.map(section)}
              </SettingsGroup>
            )}
            {contributedGroups.map((group) => (
              <SettingsGroup key={group.label} label={group.label}>
                {group.sections.map(section)}
              </SettingsGroup>
            ))}
            <SettingsGroup label="App">
              {!selectedCommunity &&
                section({ id: "profile", label: "Profile", icon: UserIcon })}
              {appSettingsSections.map(section)}
            </SettingsGroup>
            {developerMode && (
              <SettingsGroup label="Development">
                {section({
                  id: "developer",
                  label: "Developer",
                  icon: WrenchIcon,
                })}
              </SettingsGroup>
            )}
          </nav>
        </div>
      </Panel>
    </div>
  );
}

function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className={styles.settingsGroupTitle}>{label}</h2>
      <div className={styles.settingsGroupItems}>{children}</div>
    </section>
  );
}
