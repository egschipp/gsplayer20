"use client";

type InlineStatusTone = "info" | "success" | "warning" | "error";

type InlineStatusAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

type InlineStatusBannerProps = {
  tone?: InlineStatusTone;
  title?: string;
  message: string;
  action?: InlineStatusAction;
  className?: string;
};

export default function InlineStatusBanner({
  tone = "info",
  title,
  message,
  action,
  className,
}: InlineStatusBannerProps) {
  return (
    <div className={`inline-status inline-status-${tone}${className ? ` ${className}` : ""}`}>
      <div className="inline-status-content">
        {title ? <div className="inline-status-title">{title}</div> : null}
        <div className="inline-status-message">{message}</div>
      </div>
      {action ? (
        <button
          type="button"
          className="inline-status-action"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

