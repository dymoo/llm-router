"use client";

import { useState } from "react";
import { Dialog } from "./Dialog";
import type { RevealedSecret } from "./types";

export function SecretReveal({
  revealed,
  onDismiss,
}: {
  revealed: RevealedSecret;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const title = revealed.reason === "rotated" ? "New Secret" : "Key Secret";
  const description =
    revealed.reason === "rotated"
      ? `The previous secret for ${revealed.key.name} no longer works. Copy the new secret now. It is shown once and is not stored in the browser.`
      : `${revealed.key.name} was created. Copy the secret now. It is shown once and is not stored in the browser.`;

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(revealed.secret);
        setCopied(true);
        return;
      }
    } catch {
      setCopied(false);
    }
    setCopied(false);
  };

  return (
    <Dialog
      open
      title={title}
      description={description}
      closeOnEscape={false}
      closeOnBackdrop={false}
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy Secret"}
          </button>
          <button className="btn btn-primary" type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </>
      }
    >
      <p className="secret" tabIndex={0}>
        {revealed.secret}
      </p>
      <p className="hint">Prefix {revealed.key.prefix}</p>
    </Dialog>
  );
}
