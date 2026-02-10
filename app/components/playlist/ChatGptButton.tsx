"use client";

import {
  CHATGPT_PROMPT_TEMPLATE,
  fillChatGptPrompt,
  normalizePromptTemplate,
} from "@/lib/chatgpt/prompt";

type ChatGptButtonProps = {
  trackUrl: string | null;
  playlistNames: string[];
};

export default function ChatGptButton({
  trackUrl,
  playlistNames,
}: ChatGptButtonProps) {
  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    let template = CHATGPT_PROMPT_TEMPLATE;
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem("gs_chatgpt_prompt");
      if (stored) template = normalizePromptTemplate(stored);
    }
    const prompt = fillChatGptPrompt(template, trackUrl, playlistNames);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // ignore clipboard errors
      }
    }
    window.open("https://chatgpt.com", "_blank", "noopener,noreferrer");
  }

  return (
    <button
      type="button"
      aria-label="Open ChatGPT"
      title="Open ChatGPT"
      style={{
        color: "var(--text-primary)",
        display: "inline-flex",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
      onClick={handleClick}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="currentColor"
      >
        <path d="M12 2.2c-1.54 0-2.98.52-4.12 1.39a4.68 4.68 0 0 0-4.63 2.32 4.69 4.69 0 0 0 .35 5.06 4.69 4.69 0 0 0 2.09 6.87 4.68 4.68 0 0 0 4.28 2.78 4.68 4.68 0 0 0 4.54-2.99 4.68 4.68 0 0 0 4.78-2.12 4.69 4.69 0 0 0-.08-5.29A4.69 4.69 0 0 0 16.1 4.1 4.66 4.66 0 0 0 12 2.2Zm-2.82 3.1 4.4 2.54-1.27.73-4.4-2.53a2.86 2.86 0 0 1 1.27-.74Zm6.91 1.03a2.86 2.86 0 0 1 .55 1.38l-4.37 2.52-1.27-.73 4.4-2.53a2.9 2.9 0 0 1 .69-.64ZM6.2 9.12l4.37 2.52v1.47L6.2 10.59a2.88 2.88 0 0 1 0-1.47Zm11.6 0c.1.47.1.98 0 1.47l-4.37 2.52v-1.47l4.37-2.52ZM7.91 14.7l4.4-2.53 1.27.73-4.4 2.53a2.86 2.86 0 0 1-1.27-.73Zm8.18-.21a2.9 2.9 0 0 1-1.27.74l-4.4-2.53 1.27-.73 4.4 2.53Z" />
      </svg>
    </button>
  );
}
