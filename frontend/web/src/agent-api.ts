export interface AgentPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface Evidence {
  source: string;
  summary: string;
  url?: string;
}
export interface AgentDraft {
  id: string;
  kind: 'playlist' | 'metadata';
  title: string;
  payload: Record<string, unknown>;
  evidence: Evidence[];
  before?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'applied' | 'rejected';
  version: number;
  approved_version: number | null;
  created_at: string;
  updated_at: string;
  result: Record<string, unknown> | null;
  trace_id?: string;
}
export interface AgentTask {
  id: string;
  status: string;
  stage: string;
  checkpoint: number | Record<string, unknown>;
  counts: Record<string, number>;
  parameters: Record<string, unknown>;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  trace_id?: string;
  version: number;
  results?: {
    track_id?: string;
    title?: string;
    issues?: string[];
    metadata_version?: number;
    error_code?: string;
    analysis?: string;
    draft_ids?: string[];
  }[];
}
export interface AgentSchedule {
  id: string;
  name: string;
  enabled: boolean;
  interval_hours: number;
  timezone: string;
  parameters: Record<string, unknown>;
  next_run_at: string | null;
  version: number;
}
export interface AgentNotification {
  id: string;
  event_id: string;
  event_type: string;
  title: string;
  summary: string;
  severity: string;
  task_id: string | null;
  draft_id: string | null;
  trace_id: string | null;
  created_at: string;
  read_at: string | null;
  version: number;
  detail_route: string | null;
}
export interface NotificationPage extends AgentPage<AgentNotification> {
  next_cursor: string | null;
  unread_count: number;
  high_watermark: number;
}
export interface AgentConnection {
  protocol?: string;
  provider?: string;
  reasoning_effort?: string;
  max_output_tokens?: number;
  native_search?: boolean;
  id: string;
  name: string;
  scope: 'personal' | 'instance';
  base_url: string;
  model: string;
  timeout: number;
  shared: boolean;
  background_allowed: boolean;
  daily_call_budget: number;
  daily_calls_used?: number;
  daily_calls_remaining?: number;
  my_usage?: { calls: number; tokens?: number; unknown_calls?: number };
  enabled: boolean;
  has_api_key: boolean;
  version: number;
  capabilities: Record<string, unknown> | null;
  created_at: string;
  read_only?: boolean;
}
export interface ConversationMessage {
  sources?: {
    id: string;
    title: string;
    url: string;
    retrieved_at?: string;
    published_at?: string;
  }[];
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  run_id?: string;
}
export interface AgentRun {
  id: string;
  status: string;
  connection_id: string | null;
  error_code: string | null;
  tool_calls: unknown[];
  draft_ids: string[];
  trace_id?: string;
}
export interface Conversation {
  context_summary?: { summary: string; updated_at: string } | null;
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  connection_id?: string | null;
  messages?: ConversationMessage[];
  runs?: AgentRun[];
}
export interface TelegramTarget {
  id: string;
  name: string;
  has_token: boolean;
  verified: boolean;
  enabled: boolean;
  version: number;
  created_at: string;
}
export interface Delivery {
  id: string;
  event_id: string;
  target_id: string;
  status: string;
  attempt: number;
  next_attempt_at: string | null;
  error_code: string | null;
  message_id: string | null;
  trace_id?: string;
}
export interface NotificationPreferences {
  telegram_enabled: boolean;
  event_types: string[];
  min_severity: string;
  quiet_start: string | null;
  quiet_end: string | null;
  timezone: string;
}
export interface ToolCredential {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  token?: string;
}
