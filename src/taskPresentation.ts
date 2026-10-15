import type { TaskItem } from "./types";

export function taskTitle(task: TaskItem) {
  return task.title ?? (task.objective.length>28?task.objective.slice(0,28)+'…':task.objective);
}

export function taskStatusLabel(status: TaskItem["status"]) {
  return ({ created: "待执行", queued:"排队中", running: "执行中", waiting: "等待补充／确认", review:"待验收", completed: "已完成", stopped: "已停止", failed: "失败", blocked: "执行受阻" })[status];
}

export function taskDate(value:string|null) {
  if(!value)return '—';
  return new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value));
}
