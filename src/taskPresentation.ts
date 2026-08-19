import type { TaskItem } from "./types";

export function taskStatusLabel(status: TaskItem["status"]) {
  return status === "created" ? "待执行" : status;
}
