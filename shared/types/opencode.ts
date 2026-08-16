// Types for the opencode server HTTP API.
// Written defensively: the server evolves fast, so most fields are optional
// and renderers must tolerate unknown shapes.

export interface Project {
  id: string
  worktree: string
  vcs?: string
  time?: { created?: number; initialized?: number }
}

export interface SessionInfo {
  id: string
  title?: string
  version?: string
  directory?: string
  parentID?: string
  time?: { created?: number; updated?: number }
  share?: { url?: string }
  revert?: unknown
}

export interface TokenUsage {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: 'user' | 'assistant'
  time?: { created?: number; completed?: number }
  cost?: number
  tokens?: TokenUsage
  modelID?: string
  providerID?: string
  mode?: string
  agent?: string
  variant?: string
  system?: string[]
  error?: { name?: string; data?: { message?: string } } & Record<string, unknown>
  summary?: boolean
}

export interface TextPart {
  id: string
  messageID: string
  sessionID: string
  type: 'text'
  text: string
  synthetic?: boolean
  time?: { start?: number; end?: number }
}

export interface ReasoningPart {
  id: string
  messageID: string
  sessionID: string
  type: 'reasoning'
  text: string
  time?: { start?: number; end?: number }
}

export interface FilePart {
  id: string
  messageID: string
  sessionID: string
  type: 'file'
  mime: string
  filename?: string
  url: string
  source?: unknown
}

export interface ToolStatePending { status: 'pending' }
export interface ToolStateRunning {
  status: 'running'
  input?: unknown
  title?: string
  metadata?: Record<string, unknown>
  time?: { start?: number }
}
export interface ToolStateCompleted {
  status: 'completed'
  input?: Record<string, unknown>
  output?: string
  title?: string
  metadata?: Record<string, unknown>
  time?: { start?: number; end?: number }
}
export interface ToolStateError {
  status: 'error'
  input?: Record<string, unknown>
  error?: string
  time?: { start?: number; end?: number }
}
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface ToolPart {
  id: string
  messageID: string
  sessionID: string
  type: 'tool'
  callID?: string
  tool: string
  state: ToolState
}

export interface StepStartPart {
  id: string
  messageID: string
  sessionID: string
  type: 'step-start'
}

export interface StepFinishPart {
  id: string
  messageID: string
  sessionID: string
  type: 'step-finish'
  cost?: number
  tokens?: TokenUsage
}

export interface GenericPart {
  id: string
  messageID: string
  sessionID: string
  type: string
  [key: string]: unknown
}

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | GenericPart

export interface MessageWithParts {
  info: MessageInfo
  parts: Part[]
}

export interface ModelInfo {
  id: string
  name?: string
  reasoning?: boolean
  capabilities?: { reasoning?: boolean; [key: string]: unknown }
  attachment?: boolean
  cost?: { input?: number; output?: number }
  limit?: { context?: number; output?: number }
  variants?: Record<string, unknown>
  [key: string]: unknown
}

export interface ProviderInfo {
  id: string
  name?: string
  models: Record<string, ModelInfo>
  [key: string]: unknown
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
  default: Record<string, string>
}

export interface AgentInfo {
  name: string
  description?: string
  mode?: 'primary' | 'subagent' | 'all'
  builtIn?: boolean
  model?: { providerID?: string; modelID?: string }
  [key: string]: unknown
}

export interface McpStatus {
  status?: string
  error?: string
  [key: string]: unknown
}

export interface PermissionRequest {
  id: string
  sessionID: string
  messageID?: string
  callID?: string
  type?: string
  pattern?: string | string[]
  title: string
  metadata?: Record<string, unknown>
  time?: { created?: number }
}

export interface OpencodeEvent {
  type: string
  properties?: Record<string, unknown>
}

export interface FileEntry {
  name: string
  path?: string
  type?: string
  directory?: boolean
  ignored?: boolean
  [key: string]: unknown
}

export interface TodoItem {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | string
  priority?: string
}
