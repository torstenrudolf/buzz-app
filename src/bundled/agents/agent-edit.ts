import type { AgentEdit, AgentView } from "../../features/agents/control";

export interface AgentDraft {
  revision: number;
  name: string;
  picture?: string;
  systemPrompt: string;
  sessionPolicy: "channel" | "thread" | null;
  workspace: string;
  command: string;
  args: string;
  model: string;
  provider: string;
  environment: Record<string, string | null>;
  databricks?: { host: string; filter: string } | null;
}
export function isGoose(command: string): boolean {
  return command.replaceAll("\\", "/").split("/").at(-1) === "goose";
}
/** Agent defaults harness a saved command belongs to, matching native. */
export function harnessKind(
  command: string,
): "buzz-agent" | "goose" | "pi" | undefined {
  const name = command.replaceAll("\\", "/").split("/").at(-1);
  if (name === "buzz-agent") return "buzz-agent";
  if (name === "goose") return "goose";
  if (name === "buzz-pi-acp") return "pi";
  return undefined;
}
// Goose provider config keys, checked against built-in ConfigKey declarations
// and declarative provider api_key_env values. OAuth/local providers have none.
const GOOSE_API_KEYS: Record<string, { label: string; env: string }> = {
  openai: { label: "OpenAI", env: "OPENAI_API_KEY" },
  anthropic: { label: "Anthropic", env: "ANTHROPIC_API_KEY" },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY" },
  google: { label: "Google Gemini", env: "GOOGLE_API_KEY" },
  groq: { label: "Groq", env: "GROQ_API_KEY" },
  mistral: { label: "Mistral AI", env: "MISTRAL_API_KEY" },
  together: { label: "Together AI", env: "TOGETHER_API_KEY" },
  perplexity: { label: "Perplexity", env: "PERPLEXITY_API_KEY" },
  cerebras: { label: "Cerebras", env: "CEREBRAS_API_KEY" },
  custom_deepseek: { label: "DeepSeek", env: "DEEPSEEK_API_KEY" },
};
export function gooseApiKey(provider: string) {
  return GOOSE_API_KEYS[provider];
}
// Pi provider key variables from `pi --help`. Buzz never inherits shell-exported
// keys, so these are the providers someone can sign in to from the agent form.
export const PI_API_KEYS: Record<string, { label: string; env: string }> = {
  openai: { label: "OpenAI", env: "OPENAI_API_KEY" },
  anthropic: { label: "Anthropic", env: "ANTHROPIC_API_KEY" },
  google: { label: "Google Gemini", env: "GEMINI_API_KEY" },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY" },
};
export function agentDraft(agent: AgentView): AgentDraft {
  const databricks = agent.harness.databricks;
  return {
    revision: agent.revision,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    sessionPolicy: agent.sessionPolicy ?? null,
    workspace: agent.workspace,
    command: agent.harness.command,
    args: JSON.stringify(agent.harness.args, null, 2),
    model: agent.harness.model,
    provider: agent.harness.provider,
    environment: {},
    ...(databricks ? { databricks: { ...databricks } } : {}),
  };
}
export function agentEdit(
  draft: AgentDraft,
  modelDiscovery = false,
): AgentEdit {
  if (!modelDiscovery && !draft.name.trim())
    throw new Error("Enter an agent name.");
  if (!draft.command.trim()) throw new Error("Enter a harness executable.");
  if (!modelDiscovery && !draft.workspace.trim())
    throw new Error("Enter a workspace path.");
  let args: unknown;
  try {
    args = JSON.parse(draft.args);
  } catch {
    throw new Error("Arguments must be a JSON array of strings.");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Arguments must be a JSON array of strings.");
  }
  if (args.some((arg) => arg === "" || arg.includes(","))) {
    throw new Error(
      "ACP arguments must be nonempty and cannot contain commas.",
    );
  }
  return {
    name: draft.name,
    ...(draft.picture === undefined ? {} : { picture: draft.picture }),
    systemPrompt: draft.systemPrompt,
    sessionPolicy: draft.sessionPolicy,
    workspace: draft.workspace,
    harness: {
      command: draft.command,
      args,
      model: draft.model,
      provider: draft.provider,
      ...(draft.databricks ? { databricks: { ...draft.databricks } } : {}),
    },
    environment: { ...draft.environment },
  };
}
export function agentProcessLabel(agent: AgentView): string {
  switch (agent.status) {
    case "running":
      return "Process running · relay readiness unverified";
    case "waiting":
      return "Waiting to start · unlock Keychain if prompted";
    case "starting":
      return "Starting process";
    case "stopping":
      return "Stopping process";
    case "failed":
      return "Process failed";
    case "stopped":
      return "Process stopped";
  }
}
