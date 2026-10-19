import {ArrowDown, ArrowUp, ArrowUpDown} from "lucide-react";
import s from "./WorkbenchSurface.module.css";
export function SortHeading({label, direction, onClick}: {label:string; direction?:"ascending"|"descending"; onClick:()=>void}) {
  return <button type="button" className={s.sortHeading} onClick={onClick}>{label}{direction === "ascending" ? <ArrowUp size={13} aria-hidden="true"/> : direction === "descending" ? <ArrowDown size={13} aria-hidden="true"/> : <ArrowUpDown size={13} aria-hidden="true"/>}</button>;
}
