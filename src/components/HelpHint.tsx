import {Info} from "lucide-react";
import s from "./HelpHint.module.css";
export function HelpHint({label,detail}: {label?:string;detail:string}) {
  return <span className={s.root} title={detail} tabIndex={0} aria-label={detail}>{label}<Info size={12} aria-hidden="true"/></span>;
}
