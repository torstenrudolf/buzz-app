# Exact-text input correction audit

Search queries, public keys, code, and machine identifiers should not be silently
rewritten by an OS keyboard. Use `autoCorrect="off"`, `autoCapitalize="none"`, and
`spellCheck={false}` for those fields. Spellcheck alone does not disable correction.
Keep ordinary writing fields unchanged; a global `Input`/`Textarea` opt-out would
also degrade messages, descriptions, profile bios, feedback, and instructions.

## Included in the identity-preview change

- `SearchField` and `Combobox.Control` default to exact-text entry, with explicit
  caller overrides still supported.
- `Textarea variant="code"` applies the same defaults; its prose variant does not.
- `channel-templates/TemplateFields.tsx` disables correction for agent name/npub search.
- Member search inherits the shared `SearchField` defaults.

## Follow-up candidates, not repaired by this change

Audited the following `src/` inputs on 2026-09-29. These need field-level decisions,
not a blanket default on every text field. Some already disable spellcheck or
capitalization, but do not explicitly disable autocorrect.

| Source | Exact-text fields |
| --- | --- |
| `app/PluginImport.tsx` | Repository URL, branch/tag |
| `app/AgentDefaultsCard.tsx` | Provider/model/effort, environment keys and values |
| `features/identity/IdentitySetup.tsx` | Secret-key import |
| `features/communities/CommunityDialog.tsx` | Relay URL and invite code |
| `features/browser/BrowserHostView.tsx` | Address bar |
| `features/profiles/AvatarEditor.tsx` | Picture URL and emoji |
| `bundled/hosted-communities/HostedCommunities.tsx` | Domain slug, transfer recipient npub |
| `bundled/agents/AgentSettingsFields.tsx` | API key including revealed state, workspace path, arguments JSON |
| `bundled/agents/AgentHarnessEditor.tsx` | Harness argument text |
| `bundled/agents/AgentEnvironmentEditor.tsx` | Environment keys and values |
| `bundled/agents/AgentModelPicker.tsx` | Model ID, host, model filter |
| `bundled/agents/AgentImport.tsx` | Import destination path |
| `bundled/channels/CreateChannelDialog.tsx` | Channel name |
| `bundled/channels/ChannelLifecycleDialog.tsx` | Exact channel-name confirmation |
| `bundled/workflows/WorkflowEditor.tsx` | Workflow identifiers and YAML |
| `bundled/workflows/WorkflowConditions.tsx` | Expressions and condition values |
| `bundled/workflows/WorkflowForm.tsx` | Emoji, durations, expressions, step/channel identifiers |
| `bundled/workflows/WorkflowWebhookFields.tsx` | URL, headers, body |

Use the code textarea variant where it already fits rather than duplicating its
defaults. For mixed inputs such as environment values and webhook bodies, preserve
exact bytes even when the value happens to resemble prose. Browser DOM tests prove
attributes and override behavior, not native keyboard behavior: confirm correction
and capitalization on macOS/iOS before claiming platform-level coverage.
