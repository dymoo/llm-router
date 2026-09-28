"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { Dialog } from "./Dialog";
import { PRIORITY_LABEL, explainPriority, usesCloud } from "./explain";
import { fromDateTimeLocal, toDateTimeLocal } from "./format";
import { POLICY_PRESETS } from "./presets";
import { validateDraft } from "./policy";
import type { KeyDraft, KeyPolicy, PolicyPresetId } from "./types";

export function KeyEditor({
  mode,
  draft,
  busy,
  error,
  conflict,
  onChange,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  draft: KeyDraft;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  onChange: (draft: KeyDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [preset, setPreset] = useState<PolicyPresetId | null>(
    mode === "create" ? "standard" : null,
  );
  const validation = useMemo(() => validateDraft(draft), [draft]);
  const priorityId = useId();
  const priorityHintId = useId();
  const cloudHintId = useId();
  const low = draft.policy.priority === "low";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validation || busy) {
      return;
    }
    onSubmit();
  };

  const editPolicy = (patch: Partial<KeyPolicy>) => {
    setPreset(null);
    onChange({ ...draft, policy: { ...draft.policy, ...patch } });
  };

  return (
    <Dialog
      open
      title={mode === "create" ? "Create Key" : "Edit Key"}
      size="lg"
      description={
        mode === "create"
          ? "A suggestion fills in the policy; it doesn’t name the key."
          : "Saving replaces this key’s policy. The secret isn’t shown again."
      }
      onClose={busy ? undefined : onClose}
      closeOnEscape={!busy}
      closeOnBackdrop={!busy}
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="key-editor-form"
            disabled={busy || validation !== null}
          >
            {busy ? "Saving…" : mode === "create" ? "Create Key" : "Save Key"}
          </button>
        </>
      }
    >
      <form id="key-editor-form" className="form-grid" onSubmit={submit}>
        {conflict ? (
          <div className="banner" data-tone="warn" role="status">
            <div>
              <h2>This key was updated elsewhere</h2>
              <p>Your draft is still here. Save again to apply it.</p>
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            maxLength={80}
            required
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <fieldset className="field fieldset-plain">
          <legend className="field-label">Suggestion</legend>
          <div className="chips">
            {POLICY_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={preset === item.id}
                disabled={busy}
                title={item.summary}
                onClick={() => {
                  setPreset(item.id);
                  onChange({ ...draft, policy: { ...item.policy } });
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <span id={priorityId}>Priority</span>
          <div
            className="segmented"
            role="radiogroup"
            aria-labelledby={priorityId}
            aria-describedby={priorityHintId}
          >
            {(["high", "medium", "low"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.policy.priority === value}
                disabled={busy}
                onClick={() => editPolicy({ priority: value })}
              >
                {PRIORITY_LABEL[value]}
              </button>
            ))}
          </div>
          <p id={priorityHintId} className="hint" aria-live="polite">
            {explainPriority(draft.policy.priority)}
          </p>
        </div>
        <div className="field">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={usesCloud(draft.policy)}
              disabled={busy || low}
              aria-describedby={cloudHintId}
              onChange={(event) => editPolicy({ cloud: event.target.checked })}
            />
            <span>Cloud</span>
          </label>
          <p id={cloudHintId} className="hint">
            {low
              ? "Low priority never uses cloud."
              : "May use OpenRouter (paid) when the GPU can’t take the request."}
          </p>
        </div>
        <div className="form-row split">
          <NumberField
            label="Requests / minute"
            value={draft.policy.requestsPerMinute}
            disabled={busy}
            onChange={(requestsPerMinute) => editPolicy({ requestsPerMinute })}
          />
          <NumberField
            label="Max concurrent"
            value={draft.policy.maxConcurrent}
            disabled={busy}
            onChange={(maxConcurrent) => editPolicy({ maxConcurrent })}
          />
        </div>
        <p className="hint">Abuse limits. 0 means unlimited.</p>
        <label className="field">
          <span>Expires</span>
          <input
            type="datetime-local"
            value={toDateTimeLocal(draft.expiresAt)}
            onChange={(event) =>
              onChange({ ...draft, expiresAt: fromDateTimeLocal(event.target.value) })
            }
            disabled={busy}
          />
          <span className="hint">Leave empty for no expiry.</span>
        </label>
        {validation ? <p className="field-error">{validation}</p> : null}
      </form>
    </Dialog>
  );
}

function NumberField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={Number.isFinite(value) ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
