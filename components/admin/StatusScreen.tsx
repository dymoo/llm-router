import type { ReactNode } from "react";
import { Companion, type CompanionMood } from "./Companion";

/** A full-screen companion moment: loading, a failed load, or a missing page. */
export function StatusScreen({
  mood,
  title,
  detail,
  action,
  busy = false,
}: {
  mood: CompanionMood;
  title: string;
  detail?: string;
  action?: ReactNode;
  busy?: boolean;
}) {
  return (
    <main
      id="main"
      aria-busy={busy || undefined}
      className="grid min-h-dvh place-items-center px-6 pt-[calc(3rem+var(--safe-top))] pb-[calc(3rem+var(--safe-bottom))] text-center"
    >
      <div className="flex max-w-sm flex-col items-center" role={busy ? "status" : undefined}>
        <Companion mood={mood} size={92} />
        <h1 className="type-title-2 mt-5">{title}</h1>
        {detail ? <p className="type-subhead mt-2 text-label-2">{detail}</p> : null}
        {action ? <div className="mt-6">{action}</div> : null}
      </div>
    </main>
  );
}
