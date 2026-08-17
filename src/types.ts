export type Section = "chat" | "knowledge" | "automation" | "tasks";

export type ConversationView = "new" | "existing";

export type WorkApproval = "pending" | "approved" | "rejected";

export type KnowledgeItem = {
  title: string;
  scope: string;
  updated: string;
  tags: string[];
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
  title: string;
  status: string;
  owner: string;
  updated: string;
  progress: string;
};
