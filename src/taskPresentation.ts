import type { TaskItem } from "./types";

export function taskStatusLabel(status: TaskItem["status"]) {
  return ({ created: "待执行", running: "执行中", waiting: "等待补充／确认", completed: "已完成", stopped: "已停止", failed: "失败", blocked: "执行受阻" })[status];
}
