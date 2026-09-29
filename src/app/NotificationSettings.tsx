import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { Button } from "../shared/design-system/ui/Button";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Select } from "../shared/design-system/ui/Select";
import { PauseIcon, PlayIcon } from "../shared/design-system/icons/index";
import { UnreadIndicatorSettings } from "./UnreadIndicatorSettings";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { NotificationsService } from "../features/notifications/service";
import type { NotificationCategory } from "../features/notifications/preferences";
import {
  CATEGORY_SOUND_DESCRIPTIONS,
  CATEGORY_SOUND_LABELS,
  RECOMMENDED_SOUND_BY_CATEGORY,
  SOUND_NAMES,
  type SoundName,
} from "../features/notifications/sound";
import styles from "./NotificationSettings.module.css";

// Reference row order: direct messages, mentions, thread replies.
const SOUND_ROWS: readonly NotificationCategory[] = [
  "direct",
  "mention",
  "thread",
];

// The waveform SVGs use fill="currentColor", which an <img> can't inherit,
// so render them as a mask over the current text color instead.
function Waveform({ name }: { name: SoundName }) {
  const maskImage = `url(/sounds/${name}.svg)`;
  return (
    <span
      aria-hidden="true"
      className={styles.waveform}
      style={{ maskImage, WebkitMaskImage: maskImage }}
    />
  );
}

function AlertSoundRow({
  category,
  value,
  disabled,
  isPlaying,
  onChange,
  onPreview,
}: {
  category: NotificationCategory;
  value: SoundName;
  disabled: boolean;
  isPlaying: boolean;
  onChange: (next: SoundName) => void;
  onPreview: () => void;
}) {
  const recommended = RECOMMENDED_SOUND_BY_CATEGORY[category];

  const names = [
    recommended,
    ...SOUND_NAMES.filter((name) => name !== recommended).sort(),
  ];
  return (
    <div className={styles.soundRow} data-disabled={disabled || undefined}>
      <div className={styles.soundRowContent}>
        <span className={styles.soundRowLabel}>
          {CATEGORY_SOUND_LABELS[category]}
        </span>
        <span className="text-body-sm text-muted">
          {CATEGORY_SOUND_DESCRIPTIONS[category]}
        </span>
      </div>
      <span className={styles.soundControls}>
        <Waveform name={value} />
        <Select
          label={CATEGORY_SOUND_LABELS[category]}
          variant="compact"
          disabled={disabled}
          value={value}
          valueLabel={value}
          groups={[
            {
              label: "",
              options: names.map((name) => ({
                value: name,
                label: name === recommended ? `${name} rec.` : name,
              })),
            },
          ]}
          onValueChange={(next) => onChange(next as SoundName)}
        />
        <IconButton
          aria-label={isPlaying ? `Pause ${value}` : `Preview ${value}`}
          disabled={disabled}
          icon={
            isPlaying ? (
              <PauseIcon size={14} aria-hidden="true" />
            ) : (
              <PlayIcon size={14} aria-hidden="true" />
            )
          }
          size="compact"
          type="button"
          onClick={onPreview}
        />
      </span>
    </div>
  );
}

export function NotificationSettings({
  notifications,
  active = true,
}: {
  notifications: NotificationsService;
  active?: boolean;
}) {
  const state = useSyncExternalStore(
    notifications.subscribe,
    notifications.snapshot,
  );
  const { preferences, permission } = state;
  const [preview, setPreview] = useState<{
    category: NotificationCategory;
    name: SoundName;
  } | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const stopPreview = useCallback((owner?: HTMLAudioElement) => {
    const audio = previewAudio.current;
    if (owner && audio !== owner) return;
    previewAudio.current = null;
    if (audio) {
      audio.onended = null;
      audio.onpause = null;
      audio.onerror = null;
      audio.pause();
    }
    setPreview(null);
  }, []);
  const togglePreview = useCallback(
    (category: NotificationCategory, name: SoundName) => {
      if (preview?.category === category && preview.name === name) {
        stopPreview();
        return;
      }
      stopPreview();
      try {
        const audio = new Audio(`/sounds/${name}.mp3`);
        previewAudio.current = audio;
        setPreview({ category, name });
        const stop = () => stopPreview(audio);
        audio.onended = stop;
        audio.onpause = stop;
        audio.onerror = stop;
        void audio.play().catch(stop);
      } catch {
        stopPreview();
      }
    },
    [preview, stopPreview],
  );
  useEffect(
    () => () => {
      const audio = previewAudio.current;
      previewAudio.current = null;
      if (audio) {
        audio.onended = null;
        audio.onpause = null;
        audio.onerror = null;
        audio.pause();
      }
    },
    [],
  );
  useEffect(() => {
    if (
      preview &&
      (!active ||
        !preferences.enabled ||
        !preferences.sound ||
        preferences.categories[preview.category] === false ||
        preferences.sounds[preview.category] !== preview.name)
    )
      stopPreview();
  }, [active, preferences, preview, stopPreview]);
  const desktopAlertsEnabled = !state.developmentPaused && preferences.enabled;
  const permissionStatus = state.developmentPaused
    ? "Notifications are paused by your local development setting. Remove BUZZ_DEV_NOTIFICATIONS=0 from .env.local and restart the dev server to resume normal behavior. Your saved alert choices are unchanged."
    : state.requesting
      ? "Waiting for system permission…"
      : permission === "denied"
        ? "Notifications are off. Turn them on in your browser or system settings."
        : permission === "unsupported"
          ? "This build can’t show system notifications."
          : permission === "default"
            ? "Allow notifications to receive alerts."
            : null;
  return (
    <section
      className={styles.root}
      aria-labelledby="notification-settings-title"
    >
      <Header
        id="notification-settings-title"
        title="Notifications"
        subtitle="Desktop alerts are on by default. Fine-tune what gets through below."
      />
      <div className="grid grid-cols-1 gap-5">
        <div className={styles.preferenceList}>
          {state.categories.map(({ key, label }) => (
            <SwitchPreferenceRow
              key={key}
              label={label}
              checked={preferences.categories[key] !== false}
              onCheckedChange={(enabled) =>
                notifications.updatePreferences({
                  categories: { ...preferences.categories, [key]: enabled },
                })
              }
            />
          ))}
        </div>
        <SwitchPreferenceRow
          label="Desktop alerts"
          description={
            desktopAlertsEnabled
              ? "Native desktop alerts are enabled for the categories you have armed below."
              : "Request OS permission and surface new mentions or needs-action items outside the app."
          }
          checked={desktopAlertsEnabled}
          disabled={state.developmentPaused}
          onCheckedChange={(enabled) =>
            notifications.updatePreferences({ enabled })
          }
        />
        {(permissionStatus ||
          (!state.systemManaged && !state.developmentPaused)) && (
          <div
            className={styles.permission}
            data-warning={
              state.developmentPaused ||
              permission === "denied" ||
              permission === "default" ||
              permission === "unsupported" ||
              undefined
            }
          >
            {permissionStatus && (
              <p role="status" className="text-body-sm">
                {permissionStatus}
              </p>
            )}
            {!state.systemManaged && !state.developmentPaused && (
              <div className={styles.actions}>
                {permission === "default" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    disabled={state.requesting}
                    onClick={() => void notifications.requestPermission()}
                  >
                    Allow notifications
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  disabled={state.requesting}
                  onClick={() => void notifications.refreshPermission()}
                >
                  Check permission
                </Button>
              </div>
            )}
          </div>
        )}
        <div className={styles.nestedPreferences}>
          <SwitchPreferenceRow
            label="Notify while viewing"
            description="Also alert for direct messages in the conversation you have open."
            checked={preferences.notifyWhileViewing}
            disabled={!desktopAlertsEnabled}
            onCheckedChange={(notifyWhileViewing) =>
              notifications.updatePreferences({ notifyWhileViewing })
            }
          />
          <SwitchPreferenceRow
            label="Sound"
            description="Alert with a sound for the events below."
            checked={preferences.sound}
            disabled={!desktopAlertsEnabled}
            onCheckedChange={(sound) =>
              notifications.updatePreferences({ sound })
            }
          />
          {desktopAlertsEnabled && preferences.sound && (
            <div className={styles.soundRows}>
              {SOUND_ROWS.map((category) => (
                <AlertSoundRow
                  key={category}
                  category={category}
                  disabled={preferences.categories[category] === false}
                  isPlaying={preview?.category === category}
                  value={preferences.sounds[category]}
                  onPreview={() =>
                    togglePreview(category, preferences.sounds[category])
                  }
                  onChange={(next) =>
                    notifications.updatePreferences({
                      sounds: { ...preferences.sounds, [category]: next },
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
        <UnreadIndicatorSettings
          indicator={notifications.indicator}
          active={active}
        />
        {active && state.preferencesError && (
          <ToastNotice
            title="Notification choices weren’t saved"
            description={state.preferencesError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => notifications.updatePreferences({})}
            >
              Retry saving choices
            </Button>{" "}
            <Button
              type="button"
              size="sm"
              onClick={() => notifications.reloadPreferences()}
            >
              Reload saved choices
            </Button>
          </ToastNotice>
        )}
        {active && state.error && (
          <ToastNotice
            title="Buzz couldn’t send the notification"
            description={state.error}
          />
        )}
      </div>
    </section>
  );
}
