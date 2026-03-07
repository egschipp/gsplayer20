"use client";

import { useMemo, useState } from "react";
import {
  CHATGPT_PROMPT_TEMPLATE,
  CHATGPT_PROMPT_TOKENS,
  CHATGPT_PROMPT_TOKEN_LABELS,
  normalizePromptTemplate,
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
    label: "Artiest & album",
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
  description = "Beheer exact dezelfde prompt-template die vanuit de muziekbibliotheek naar ChatGPT wordt gekopieerd.",
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
    let next = value ?? "";
    const unknown = next.match(/\[[^\]]+\]/g)?.filter(
      (match) => !(CHATGPT_PROMPT_TOKENS as readonly string[]).includes(match)
    );
    if (unknown?.length) {
      setPromptWarning(`Onbekende variabelen verwijderd: ${unknown.join(", ")}`);
    } else {
      setPromptWarning(null);
    }
    next = next.replace(/\[[^\]]+\]/g, (match) => {
      if ((CHATGPT_PROMPT_TOKENS as readonly string[]).includes(match)) {
        return match;
      }
      return match.replace("[", "").replace("]", "");
    });
    return normalizePromptTemplate(next);
  }

  function handlePromptChange(value: string) {
    setPromptSaved(null);
    setPromptTemplate(enforceTokens(value));
  }

  function savePrompt() {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("gs_chatgpt_prompt", promptTemplate);
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
            <span className="ops-prompt-label">Prompt-template</span>
            <textarea
              className="input ops-prompt-textarea"
              value={promptTemplate}
              onChange={(event) => handlePromptChange(event.target.value)}
            />
          </label>

          <div className="ops-inline-actions">
            <button type="button" className="btn btn-outline-green" onClick={savePrompt}>
              Opslaan
            </button>
            <button type="button" className="btn btn-secondary" onClick={resetPrompt}>
              Herstellen
            </button>
            {promptSaved === "saved" ? (
              <span className="text-subtle">Opgeslagen in deze browser</span>
            ) : promptSaved === "error" ? (
              <span className="text-subtle">Opslaan mislukt</span>
            ) : (
              <span className="text-subtle">Gebruik exact dezelfde promptflow als in My Music.</span>
            )}
          </div>
        </div>

        <aside className="ops-prompt-side">
          <div className="ops-prompt-card">
            <strong className="ops-prompt-card-title">Beschikbare variabelen</strong>
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
            <strong className="ops-prompt-card-title">Gebruik in de app</strong>
            <ol className="ops-prompt-usage-list">
              <li>Selecteer een track in My Music.</li>
              <li>De ChatGPT-knop leest deze template uit `localStorage`.</li>
              <li>Track metadata wordt verrijkt via `/api/spotify/tracks/meta`.</li>
              <li>De prompt wordt gevuld, gekopieerd en ChatGPT opent in een nieuw tabblad.</li>
            </ol>
          </div>
        </aside>
      </div>
    </section>
  );
}
