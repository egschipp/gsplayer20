"use client";

import { useMemo, useState } from "react";
import {
  CHATGPT_PROMPT_TEMPLATE,
  CHATGPT_PROMPT_TOKEN_LABELS,
  finalizePromptTemplate,
  normalizePromptTemplate,
  sanitizePromptTemplateInput,
} from "@/lib/chatgpt/prompt";

type PromptSettingsPanelProps = {
  title?: string;
  description?: string;
};

type SaveState = null | "saved" | "error";

const TOKEN_GROUPS = [
  {
    label: "Track",
    tokens: ["[TRACK_URL]", "[TRACK_ID]", "[TRACK_NAME]", "[DURATION_MS]"],
  },
  {
    label: "Artist & album",
    tokens: [
      "[ARTIST_IDS]",
      "[ARTIST_NAMES]",
      "[ALBUM_ID]",
      "[ALBUM_RELEASE_DATE]",
    ],
  },
  {
    label: "Validatie",
    tokens: ["[TRACK_META]", "[ISRC]", "[EXPLICIT]", "[POPULARITY]"],
  },
  {
    label: "Context",
    tokens: ["[PLAYLISTS]"],
  },
] as const;

function buildTokenGroups() {
  const labelMap = new Map(
    CHATGPT_PROMPT_TOKEN_LABELS.map((entry) => [entry.token, entry.label])
  );
  return TOKEN_GROUPS.map((group) => ({
    ...group,
    items: group.tokens.map((token) => ({
      token,
      label: labelMap.get(token) ?? token,
    })),
  }));
}

export default function PromptSettingsPanel({
  title = "AI / ChatGPT prompt",
  description = "Manage the exact same prompt template that gets copied to ChatGPT from the music library.",
}: PromptSettingsPanelProps) {
  const [promptTemplate, setPromptTemplate] = useState(() => {
    if (typeof window === "undefined") {
      return CHATGPT_PROMPT_TEMPLATE;
    }
    const stored = window.localStorage.getItem("gs_chatgpt_prompt");
    return stored ? normalizePromptTemplate(stored) : CHATGPT_PROMPT_TEMPLATE;
  });
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [promptSaved, setPromptSaved] = useState<SaveState>(null);

  const tokenGroups = useMemo(() => buildTokenGroups(), []);

  function enforceTokens(value: string) {
    const { template, unknownTokens: unknown } = sanitizePromptTemplateInput(value);
    if (unknown?.length) {
      setPromptWarning(`Removed unknown variables: ${unknown.join(", ")}`);
    } else {
      setPromptWarning(null);
    }
    return template;
  }

  function handlePromptChange(value: string) {
    setPromptSaved(null);
    setPromptTemplate(enforceTokens(value));
  }

  function savePrompt() {
    try {
      const next = finalizePromptTemplate(promptTemplate);
      setPromptTemplate(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("gs_chatgpt_prompt", next);
      }
      setPromptSaved("saved");
    } catch {
      setPromptSaved("error");
    }
  }

  function resetPrompt() {
    const base = CHATGPT_PROMPT_TEMPLATE;
    setPromptTemplate(base);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("gs_chatgpt_prompt", base);
      }
      setPromptSaved("saved");
      setPromptWarning(null);
    } catch {
      setPromptSaved("error");
    }
  }

  return (
    <section className="ops-prompt-studio">
      <div className="ops-section-head">
        <div className="ops-stack-tight">
          <h3 className="ops-section-title">{title}</h3>
          <p className="ops-panel-copy">{description}</p>
        </div>
      </div>

      <div className="ops-prompt-grid">
        <div className="ops-prompt-main">
          {promptWarning ? (
            <div className="ops-inline-alert ops-tone-warn" role="status" aria-live="polite">
              {promptWarning}
            </div>
          ) : null}

          <label className="ops-prompt-editor">
            <span className="ops-prompt-label">Prompt template</span>
            <textarea
              className="input ops-prompt-textarea"
              value={promptTemplate}
              onChange={(event) => handlePromptChange(event.target.value)}
            />
          </label>

          <div className="ops-inline-actions">
            <button type="button" className="btn btn-outline-green" onClick={savePrompt}>
              Save
            </button>
            <button type="button" className="btn btn-secondary" onClick={resetPrompt}>
              Reset
            </button>
            {promptSaved === "saved" ? (
              <span className="text-subtle">Saved in this browser</span>
            ) : promptSaved === "error" ? (
              <span className="text-subtle">Save failed</span>
            ) : (
              <span className="text-subtle">Uses the exact same prompt flow as My Music.</span>
            )}
          </div>
        </div>

        <aside className="ops-prompt-side">
          <div className="ops-prompt-card">
            <strong className="ops-prompt-card-title">Available variables</strong>
            <div className="ops-prompt-token-groups">
              {tokenGroups.map((group) => (
                <div key={group.label} className="ops-prompt-token-group">
                  <span className="ops-prompt-token-group-label">{group.label}</span>
                  <div className="ops-prompt-token-list">
                    {group.items.map((item) => (
                      <div key={item.token} className="ops-prompt-token-item">
                        <code>{item.token}</code>
                        <span className="text-subtle">{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="ops-prompt-card">
            <strong className="ops-prompt-card-title">How it is used</strong>
            <ol className="ops-prompt-usage-list">
              <li>Select a track in My Music.</li>
              <li>The ChatGPT button reads this template from `localStorage`.</li>
              <li>Track metadata is enriched through `/api/spotify/tracks/meta`.</li>
              <li>The prompt is filled, copied, and ChatGPT opens in a new tab.</li>
            </ol>
          </div>
        </aside>
      </div>
    </section>
  );
}
