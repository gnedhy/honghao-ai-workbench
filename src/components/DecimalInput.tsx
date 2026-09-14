import type { ComponentPropsWithRef } from "react";

/** Preserve the typed string. Parsing, precision and business validation belong to the editor. */
export function DecimalInput(props: ComponentPropsWithRef<"input">) {
  return <input type="text" inputMode="decimal" {...props}/>;
}
