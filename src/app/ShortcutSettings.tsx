import { IconButton } from "../shared/design-system/ui/IconButton";
import { PencilSimpleIcon, XIcon } from "../shared/design-system/icons";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "../shared/design-system/ui/Button";
import {
  sameBinding,
  type KeyBinding,
  type NormalizedShortcut,
} from "../features/shortcuts/bindings";
import { formatBinding, isApplePlatform } from "../features/shortcuts/format";
import { KeyCombo } from "../features/shortcuts/KeyCombo";
import {
  KeyCaptureControl,
  type CapturedChord,
} from "../features/shortcuts/KeyCaptureControl";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { PluginManager } from "../plugins/manager";

type Row = Readonly<{
  key: string;
  title: string;
  owner: string;
  /** Owner-defined presentation order within the Settings category. */
  order: number;
  defaults: readonly KeyBinding[];
  override: KeyBinding | undefined;
  effective: readonly KeyBinding[];
}>;
type Group = Readonly<{
  id: string;
  label: string;
  /** Stable owner identity for equal display labels. */
  sortKey: string;
  rows: readonly Row[];
}>;
type Notice = Readonly<{
  key: string;
  tone: "error" | "warning";
  message: string;
}>;

/** Chords the message editor handles locally before the window dispatcher: undo/redo and line/document jumps. */
const EDITOR_CHORDS: readonly KeyBinding[] = [
  { key: "z", mod: true },
  { key: "z", mod: true, shift: true },
  { key: "y", mod: true },
  { key: "y", mod: true, shift: true },
  { key: "Home", mod: true },
  { key: "Home", mod: true, shift: true },
  { key: "End", mod: true },
  { key: "End", mod: true, shift: true },
];
/** Copy, paste, cut and select all: a matching shortcut would preventDefault them everywhere. */
const CLIPBOARD_CHORDS: readonly KeyBinding[] = [
  { key: "c", mod: true },
  { key: "v", mod: true },
  { key: "x", mod: true },
  { key: "a", mod: true },
];
/** Close window and quit: the desktop shell owns these, so they are refused there. */
const DESKTOP_CHORDS: readonly KeyBinding[] = [
  { key: "q", mod: true },
  { key: "w", mod: true },
];
const includes = (chords: readonly KeyBinding[], binding: KeyBinding) =>
  chords.some((chord) => sameBinding(chord, binding));
/** Every owner supplies order; identity and title make ties deterministic. */
const byPresentation = (a: Row, b: Row) =>
  a.order - b.order ||
  a.key.localeCompare(b.key) ||
  a.title.localeCompare(b.title);

/**
 * Lists every host binding and every active plugin contribution from the live
 * dispatcher registry, so the page cannot drift from what actually fires.
 * Overrides are keyed by the registry's own identity: host id or `pluginId/id`.
 */
export function ShortcutSettings({
  shortcuts,
  bindings,
  plugins,
  apple = isApplePlatform(navigator.platform),
  desktop = isTauri(),
}: {
  shortcuts: ShortcutsService;
  bindings: ShortcutBindings;
  /** Display names for plugin groups come from the catalog. */
  plugins: Pick<PluginManager, "subscribe" | "snapshot">;
  apple?: boolean;
  /** Packaged desktop build, where close/quit chords belong to the shell. */
  desktop?: boolean;
}) {
  const host = useSyncExternalStore(
    shortcuts.hostSubscribe,
    shortcuts.hostSnapshot,
  );
  const contributed = useSyncExternalStore(
    shortcuts.subscribe,
    shortcuts.snapshot,
  );
  const { overrides, error } = useSyncExternalStore(
    bindings.subscribe,
    bindings.snapshot,
  );
  const { configuration } = useSyncExternalStore(
    plugins.subscribe,
    plugins.snapshot,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const pluginName = (id: string) =>
    (configuration.status === "ready"
      ? configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === id,
        )?.manifest.name
      : undefined) ?? id;
  const row = (
    key: string,
    shortcut: NormalizedShortcut,
    owner: string,
  ): Row => {
    const override = overrides[key];
    return {
      key,
      title: shortcut.title,
      owner,
      order: shortcut.order,
      defaults: shortcut.binding,
      override,
      effective: override ? [override] : shortcut.binding,
    };
  };
  // Group ids are namespaced so a plugin whose manifest id is "buzz" or "host"
  // cannot share a React key with the host group.
  const groups: Group[] = [
    {
      id: "host",
      label: "Buzz",
      sortKey: "",
      rows: host.map((shortcut) => row(shortcut.id, shortcut, "Buzz")),
    },
    ...[...new Set(contributed.map((shortcut) => shortcut.pluginId))]
      .map((pluginId) => {
        const label = pluginName(pluginId);
        return {
          id: `plugin:${pluginId}`,
          label,
          sortKey: pluginId,
          rows: contributed
            .filter((shortcut) => shortcut.pluginId === pluginId)
            .map((shortcut) => row(shortcut.key, shortcut, label)),
        };
      })
      .sort(
        (a, b) =>
          a.label.localeCompare(b.label) || a.sortKey.localeCompare(b.sortKey),
      ),
  ]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort(byPresentation),
    }))
    .filter((group) => group.rows.length);
  const rows = groups.flatMap((group) => group.rows);
  // A chord can become shared after capture (a plugin enabled later, a new
  // default in a release). The dispatcher then picks one silently, so each
  // affected row names the others.
  const sharedWith = (target: Row) =>
    rows.filter(
      (other) =>
        other.key !== target.key &&
        other.effective.some((binding) =>
          target.effective.some((current) => sameBinding(current, binding)),
        ),
    );
  const modified = Object.keys(overrides).length > 0;

  const start = (key: string) => {
    setEditing(key);
    setNotice(null);
  };
  const cancel = (key: string) => {
    setEditing((current) => (current === key ? null : current));
    setNotice((current) =>
      current?.key === key && current.tone === "error" ? null : current,
    );
  };
  // Conflicts are decided here, not in the dispatcher: host chords always win
  // there, and plugin ties resolve by sorted key, neither of which is a choice.
  const capture = (target: Row, { binding, otherPrimary }: CapturedChord) => {
    const chord = formatBinding(binding, apple).text;
    const refuse = (message: string) =>
      setNotice({ key: target.key, tone: "error", message });
    if (binding.key === "Dead" || binding.key === "Unidentified")
      return refuse("That key can’t be used for a shortcut. Try another.");
    if (otherPrimary)
      return refuse(
        apple
          ? "Control isn’t used for shortcuts on this device. Try Command or Option."
          : "The Windows/Command key isn’t used for shortcuts on this device. Try Control or Alt.",
      );
    if (!binding.mod && !binding.alt)
      return refuse(
        `Include ${apple ? "Command or Option" : "Control or Alt"} so ordinary typing keeps working.`,
      );
    if (includes(CLIPBOARD_CHORDS, binding))
      return refuse(
        `${chord} is reserved for copy, cut, paste and select all. Try another.`,
      );
    if (desktop && includes(DESKTOP_CHORDS, binding))
      return refuse(
        `${chord} is reserved for closing the window and quitting Buzz. Try another.`,
      );
    const conflict = rows.find(
      (row) =>
        row.key !== target.key &&
        row.effective.some((current) => sameBinding(current, binding)),
    );
    if (conflict)
      return refuse(
        `${chord} is already used by ${conflict.title} (${conflict.owner}).`,
      );
    const isDefault =
      target.defaults.length === 1 &&
      target.defaults.every((current) => sameBinding(current, binding));
    bindings.set(target.key, isDefault ? null : binding);
    setEditing(null);
    // EditableInput handles Enter locally regardless of the held modifiers.
    setNotice(
      binding.key === "Enter" || includes(EDITOR_CHORDS, binding)
        ? {
            key: target.key,
            tone: "warning",
            message: `Saved. The message editor handles ${chord} itself while you are typing, so it wins there.`,
          }
        : null,
    );
  };

  return (
    <section aria-labelledby="shortcut-settings-title">
      <Header id="shortcut-settings-title" title="Shortcuts" />
      <div className="grid gap-5">
        {groups.length ? (
          <div>
            {groups.map((group) => (
              <section key={group.id}>
                <InlineHeader level={2} title={group.label} />
                <div className="divide-y divide-standard">
                  {group.rows.map((row) => (
                    <ShortcutRow
                      key={row.key}
                      row={row}
                      apple={apple}
                      sharedWith={sharedWith(row)}
                      listening={editing === row.key}
                      notice={notice?.key === row.key ? notice : null}
                      onStart={() => start(row.key)}
                      onCancel={() => cancel(row.key)}
                      onCapture={(chord) => capture(row, chord)}
                      onReset={() => {
                        cancel(row.key);
                        setNotice(null);
                        bindings.set(row.key, null);
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="m-0 px-control-inset text-body-sm text-subtle">
            No shortcuts are available yet.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!modified}
            onClick={() => {
              setEditing(null);
              setNotice(null);
              bindings.reset();
            }}
          >
            Reset all shortcuts
          </Button>
        </div>
        {error && (
          <div role="alert" className="grid gap-3 text-body-sm text-standard">
            <p className="m-0">{error}</p>
            <div>
              <Button type="button" onClick={bindings.retry}>
                Retry saving shortcuts
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ShortcutRow({
  row,
  apple,
  sharedWith,
  listening,
  notice,
  onStart,
  onCancel,
  onCapture,
  onReset,
}: {
  row: Row;
  apple: boolean;
  /** Other listed shortcuts whose effective chord this row also answers to. */
  sharedWith: readonly Row[];
  listening: boolean;
  notice: Notice | null;
  onStart: () => void;
  onCancel: () => void;
  onCapture: (chord: CapturedChord) => void;
  onReset: () => void;
}) {
  const titleId = useId();
  const noticeId = useId();
  const change = useRef<HTMLButtonElement>(null);
  const wasListening = useRef(listening);
  const resetting = useRef(false);
  // Return focus to the row's action when the capture control or the Reset
  // button goes away without the person having moved focus somewhere else.
  useEffect(() => {
    const stopped = wasListening.current && !listening;
    wasListening.current = listening;
    if (
      (stopped || (resetting.current && !row.override)) &&
      document.activeElement === document.body
    )
      change.current?.focus();
    resetting.current = false;
  }, [listening, row.override]);
  const primary = row.effective[0];
  return (
    <article aria-labelledby={titleId}>
      <PreferenceRow
        title={
          <h3 id={titleId} className="m-0 text-label-sm">
            {row.title}
          </h3>
        }
        subtitle={
          row.override || sharedWith.length > 0 ? (
            <>
              {row.override && <span className="block">Modified</span>}
              {sharedWith.length > 0 && (
                <span className="block text-subtle">
                  Also used by{" "}
                  {sharedWith
                    .map((other) => `${other.title} (${other.owner})`)
                    .join(", ")}
                </span>
              )}
            </>
          ) : undefined
        }
        trailing={
          <>
            {listening ? (
              <KeyCaptureControl
                apple={apple}
                label={`New shortcut for ${row.title}`}
                describedBy={notice ? noticeId : undefined}
                onCapture={onCapture}
                onCancel={onCancel}
              />
            ) : (
              primary && <KeyCombo binding={primary} apple={apple} />
            )}
            <IconButton
              variant="ghost"
              icon={
                listening ? (
                  <XIcon size={16} aria-hidden="true" />
                ) : (
                  <PencilSimpleIcon size={16} aria-hidden="true" />
                )
              }
              title={listening ? "Cancel" : "Change shortcut"}
              ref={change}
              type="button"
              size="sm"
              aria-label={
                listening
                  ? `Cancel changing ${row.title}`
                  : `Change shortcut for ${row.title}`
              }
              // Keep focus on the listening control so a click here cancels once.
              onMouseDown={(event) => event.preventDefault()}
              onClick={listening ? onCancel : onStart}
            />
            {row.override && !listening && (
              <Button
                type="button"
                size="sm"
                aria-label={`Reset shortcut for ${row.title}`}
                onClick={() => {
                  resetting.current = true;
                  onReset();
                }}
              >
                Reset
              </Button>
            )}
          </>
        }
      />
      {notice && (
        <p
          id={noticeId}
          role="alert"
          className="m-0 text-body-sm text-standard"
        >
          {notice.message}
        </p>
      )}
    </article>
  );
}
