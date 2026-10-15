// Adapted from chuspeeism/dashi-taskboard web/src/taskFilters.ts (Apache-2.0).
// Uses our task fields; priority, labels and external links are not part of this panel.
import type {TaskItem,TaskStatus} from '../types';

export function matchesTaskSearch(task:TaskItem,search:string,context:string):boolean {
  const needle=search.trim().toLowerCase();
  if(!needle)return true;
  return [task.id,task.title,task.objective,context].join(' ').toLowerCase().includes(needle);
}

export function matchesTaskFilters(task:TaskItem,statuses:TaskStatus[]):boolean {
  if(statuses.length&&!statuses.includes(task.status))return false;
  return true;
}
