import type { Protocol } from '@modelbridge/runtime/contracts'
import type { UsageApp } from '@modelbridge/runtime/usage'
import type { ConfigurableApp } from '@modelbridge/runtime/apps'

type HarnessId = 'codex' | ConfigurableApp
type ManualAppId = 'openai' | 'anthropic'

export type AppInfo = {
  name: string
  // The API this app speaks to ModelBridge.
  protocol: Protocol
  description: string
} & ({ id: HarnessId; automatic: true } | { id: ManualAppId; automatic: false })

export const apps: AppInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    protocol: 'responses',
    description: 'OpenAI Codex CLI and desktop app.',
    automatic: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    protocol: 'messages',
    description: 'Anthropic’s terminal coding agent.',
    automatic: true,
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    protocol: 'chat-completions',
    description: 'Nous Research’s self-improving agent.',
    automatic: true,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    protocol: 'chat-completions',
    description: 'Personal assistant gateway for chat apps.',
    automatic: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    protocol: 'chat-completions',
    description: 'OpenCode 2.x CLI, Web and Desktop with a local server.',
    automatic: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Harness (Web)',
    protocol: 'chat-completions',
    description: 'The standard web profile started with dsh web.',
    automatic: true,
  },
  {
    id: 'deepseek-desktop',
    name: 'DeepSeek Harness (Desktop)',
    protocol: 'chat-completions',
    description:
      'The standard profile used by the DeepSeek Harness desktop app.',
    automatic: true,
  },
  {
    id: 'openai',
    name: 'Other (OpenAI-compatible)',
    protocol: 'chat-completions',
    description:
      'Any tool with a custom OpenAI base URL: Cline, Continue, Aider, LibreChat and more.',
    automatic: false,
  },
  {
    id: 'anthropic',
    name: 'Other (Anthropic-compatible)',
    protocol: 'messages',
    description: 'Any tool that accepts a custom Anthropic base URL.',
    automatic: false,
  },
]

export const protocolLabels: Record<Protocol, string> = {
  responses: 'Responses',
  'chat-completions': 'Chat Completions',
  messages: 'Anthropic Messages',
}

export const protocolPaths = {
  responses: '/v1/responses',
  'chat-completions': '/v1/chat/completions',
  messages: '/v1/messages',
} as const satisfies Record<Protocol, string>

export const usageAppLabels: Record<UsageApp | 'unknown', string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek Harness',
  playground: 'Playground',
  other: 'Other tools',
  unknown: 'Earlier requests (app not recorded)',
}
