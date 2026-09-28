"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { Dialog } from "./Dialog";
import {
  explainCostBias,
  explainLatencyBias,
  explainLocalityBias,
  explainPriority,
  explainQualityBias,
  explainQueueWait,
  localityLabel,
} from "./explain";
import { fromDateTimeLocal, toDateTimeLocal } from "./format";
import { POLICY_PRESETS, clonePolicy } from "./presets";
import {
  allowedModelsMode,
  allowedModelsToText,
  parseAllowedModels,
  validateDraft,
} from "./policy";
import type { KeyDraft, KeyPolicy, PolicyPresetId } from "./types";
import { MAX_WAIT_MS } from "./types";

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
    mode === "create" ? "balanced" : null,
  );
  const validation = useMemo(() => validateDraft(draft), [draft]);
  const allowMode = allowedModelsMode(draft.policy.allowedModels);
  const title = mode === "create" ? "Create Key" : "Edit Key";
  const localityId = useId();
  const costId = useId();
  const qualityId = useId();
  const latencyId = useId();
  const waitId = useId();
  const priorityId = useId();
  const overloadId = useId();

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

  const waitSeconds = draft.policy.maxWaitMs / 1000;

  return (
    <Dialog
      open
      title={title}
      size="lg"
      description={
        mode === "create"
          ? "Suggestions fill policy. They do not name the key. Save writes the server policy."
          : "Saving replaces the current server policy. The secret is not shown again."
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
          <legend className="field-label">Policy suggestion</legend>
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
                  onChange({ ...draft, policy: clonePolicy(item.policy) });
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <span id={priorityId}>Priority</span>
          <div className="segmented" role="radiogroup" aria-labelledby={priorityId}>
            {(["high", "medium", "low"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.policy.priority === value}
                disabled={busy}
                onClick={() => editPolicy({ priority: value })}
              >
                {value === "high" ? "High" : value === "medium" ? "Medium" : "Low"}
              </button>
            ))}
          </div>
          <p className="hint" aria-live="polite">
            {explainPriority(draft.policy.priority)}
          </p>
        </div>
        <LabeledSlider
          label={`Locality · ${localityLabel(draft.policy.localityBias)}`}
          min={0}
          max={1}
          step={0.05}
          value={draft.policy.localityBias}
          display={draft.policy.localityBias.toFixed(2)}
          disabled={busy}
          describedBy={localityId}
          explanation={explainLocalityBias(draft.policy.localityBias)}
          onChange={(localityBias) => editPolicy({ localityBias })}
        />
        <LabeledSlider
          label="Cost bias"
          min={0}
          max={1}
          step={0.05}
          value={draft.policy.bias.cost}
          display={draft.policy.bias.cost.toFixed(2)}
          disabled={busy}
          describedBy={costId}
          explanation={explainCostBias(draft.policy.bias.cost)}
          onChange={(cost) => editPolicy({ bias: { ...draft.policy.bias, cost } })}
        />
        <LabeledSlider
          label="Quality bias"
          min={0}
          max={1}
          step={0.05}
          value={draft.policy.bias.quality}
          display={draft.policy.bias.quality.toFixed(2)}
          disabled={busy}
          describedBy={qualityId}
          explanation={explainQualityBias(draft.policy.bias.quality)}
          onChange={(quality) => editPolicy({ bias: { ...draft.policy.bias, quality } })}
        />
        <LabeledSlider
          label="Latency bias"
          min={0}
          max={1}
          step={0.05}
          value={draft.policy.bias.latency}
          display={draft.policy.bias.latency.toFixed(2)}
          disabled={busy}
          describedBy={latencyId}
          explanation={explainLatencyBias(draft.policy.bias.latency)}
          onChange={(latency) => editPolicy({ bias: { ...draft.policy.bias, latency } })}
        />
        <LabeledSlider
          label="Queue wait"
          min={0}
          max={MAX_WAIT_MS}
          step={250}
          value={draft.policy.maxWaitMs}
          display={`${Number.isInteger(waitSeconds) ? waitSeconds : waitSeconds.toFixed(1)}s`}
          disabled={busy}
          describedBy={waitId}
          explanation={explainQueueWait(draft.policy.maxWaitMs)}
          onChange={(maxWaitMs) => editPolicy({ maxWaitMs })}
        />
        <div className="field">
          <span id={overloadId}>Local overload</span>
          <div className="segmented" role="radiogroup" aria-labelledby={overloadId}>
            {(["report", "failover"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={draft.policy.overloadAction === value}
                disabled={busy}
                onClick={() => editPolicy({ overloadAction: value })}
              >
                {value === "report" ? "Report overload" : "Fail over to eligible cloud"}
              </button>
            ))}
          </div>
          <p className="hint">
            {draft.policy.overloadAction === "report"
              ? "After the local wait, report overload. Overload-triggered paid cloud failover is off by default."
              : "Before dispatch, an eligible cloud deployment may be used when local capacity is unavailable. This may incur provider charges; allowlist, capability, context, credentials and estimated-spend limits still apply. A continue pin never switches silently."}
          </p>
        </div>
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
        <details className="advanced">
          <summary>Limits and allowlist</summary>
          <div className="form-grid">
            <div className="form-row split">
              <NumberField
                label="Context cap"
                value={draft.policy.contextLimitTokens}
                disabled={busy}
                onChange={(contextLimitTokens) => editPolicy({ contextLimitTokens })}
              />
              <NumberField
                label="Completion cap"
                value={draft.policy.maxCompletionTokens}
                disabled={busy}
                onChange={(maxCompletionTokens) => editPolicy({ maxCompletionTokens })}
              />
            </div>
            <div className="form-row split">
              <NumberField
                label="Requests per minute"
                value={draft.policy.requestsPerMinute}
                disabled={busy}
                onChange={(requestsPerMinute) => editPolicy({ requestsPerMinute })}
              />
              <NumberField
                label="Concurrent requests"
                value={draft.policy.maxConcurrent}
                disabled={busy}
                onChange={(maxConcurrent) => editPolicy({ maxConcurrent })}
              />
            </div>
            <label className="field">
              <span>Estimate ceiling (USD)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={draft.policy.maxEstimatedUsd ?? ""}
                disabled={busy}
                onChange={(event) => {
                  const raw = event.target.value;
                  editPolicy({
                    maxEstimatedUsd: raw.trim().length === 0 ? null : Number(raw),
                  });
                }}
              />
              <span className="hint">Empty means no ceiling. This is not a monthly budget.</span>
            </label>
            <div className="field">
              <span>Allowed deployments</span>
              <div className="segmented" role="group" aria-label="Allowed deployments">
                {(
                  [
                    ["all", "All"],
                    ["specific", "Specific"],
                    ["deny", "Deny all"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={allowMode === value}
                    disabled={busy}
                    onClick={() =>
                      editPolicy({
                        allowedModels: parseAllowedModels(
                          value,
                          allowedModelsToText(draft.policy.allowedModels),
                        ),
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              {allowMode === "specific" ? (
                <textarea
                  aria-label="Deployment IDs"
                  value={allowedModelsToText(draft.policy.allowedModels)}
                  disabled={busy}
                  onChange={(event) =>
                    editPolicy({
                      allowedModels: parseAllowedModels("specific", event.target.value),
                    })
                  }
                />
              ) : (
                <p className="hint">
                  {allowMode === "all"
                    ? "All current and future deployments."
                    : "An empty allowlist denies every deployment."}
                </p>
              )}
            </div>
          </div>
        </details>
        {validation ? <p className="field-error">{validation}</p> : null}
      </form>
    </Dialog>
  );
}

function LabeledSlider({
  label,
  min,
  max,
  step,
  value,
  display,
  disabled,
  describedBy,
  explanation,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  disabled: boolean;
  describedBy: string;
  explanation: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span className="range-readout">
        {label}
        <span>{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={display}
        aria-describedby={describedBy}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p id={describedBy} className="hint" aria-live="polite">
        {explanation}
      </p>
    </label>
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
        min={0}
        step={1}
        value={Number.isFinite(value) ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
