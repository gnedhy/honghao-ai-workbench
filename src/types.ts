export type Section = "chat" | "knowledge" | "automation" | "tasks";

export type ConversationView = "new" | "existing";

export type WorkApproval = "pending" | "approved" | "rejected";

export type Project = {
  id: string;
  title: string;
};

export type Conversation = {
  id: string;
  title: string;
  project_id: string | null;
};

export type ConversationMessage = {
  id: string;
  conversation_id: string;
  mode: "chat" | "work";
  content: string;
  created_at: string;
};

export type KnowledgeItem = {
  title: string;
  scope: string;
  updated: string;
  tags: string[];
  project?: string;
};

export type SkillItem = {
  title: string;
  version: string;
  status: string;
  description: string;
  runs: number;
};

export type WorkflowItem = {
  title: string;
  version: string;
  status: string;
  description: string;
  runs: number;
  updated: string;
  owner: string;
  steps: string[];
};

export type TaskItem = {
  id: string;
  conversation_id: string;
  objective: string;
  project_id: string | null;
  status: "created";
  created_at: string;
  latest_run: string | null;
};
