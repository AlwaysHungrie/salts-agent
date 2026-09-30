

/** Each platform's colours, spelled out because Tailwind only sees literal class names. */
export const CHANNEL_MARK = {
  telegram: {
    fade: "from-[#229ED9]/18",
    underline: "decoration-[#229ED9]",
    fill: "fill-[#229ED9]",
    path: "M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.56 8.22-1.86 8.78c-.14.62-.51.77-1.03.48l-2.85-2.1-1.37 1.32c-.15.15-.28.28-.58.28l.2-2.9 5.29-4.78c.23-.2-.05-.32-.36-.12l-6.54 4.12-2.82-.88c-.61-.19-.62-.61.13-.9l11.03-4.25c.51-.19.96.12.79.95Z",
  },
  whatsapp: {
    fade: "from-[#25D366]/18",
    underline: "decoration-[#25D366]",
    fill: "fill-[#25D366]",
    path: "M12.04 0A11.9 11.9 0 0 0 1.76 17.9L.06 24l6.25-1.64A11.9 11.9 0 1 0 12.04 0Zm0 21.8a9.9 9.9 0 0 1-5.04-1.38l-.36-.21-3.71.97.99-3.62-.24-.37a9.9 9.9 0 1 1 8.36 4.61Zm5.43-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.18.2-.35.22-.65.07a8.1 8.1 0 0 1-2.39-1.47 9 9 0 0 1-1.65-2.06c-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.42.25-.7.25-1.29.18-1.42-.08-.13-.28-.2-.58-.35Z",
  },
} as const;

/** Where a conversation that lives on another platform continues. */
export type ContinueAt = {
  label: string;
  href: string;
  channel: "telegram" | "whatsapp";
};

/**
 * Stands in for the composer on a chat-channel session: the transcript reads here, but
 * the reply has to come from the place the conversation started.
 */
export function ChannelFooter({ continueAt }: { continueAt: ContinueAt }) {
  const mark = CHANNEL_MARK[continueAt.channel];
  return (
    <div
      className={`bg-linear-to-t to-transparent px-5 py-6 text-center md:px-8 md:py-7 ${mark.fade}`}
    >
      <p className="text-muted text-sm leading-[1.43]">
        Continue this conversation in{" "}
        <a
          href={continueAt.href}
          target="_blank"
          rel="noreferrer"
          className={`text-ink inline-flex items-center gap-1 underline underline-offset-4 hover:decoration-2 ${mark.underline}`}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`h-[15px] w-[15px] ${mark.fill}`}
          >
            <path d={mark.path} />
          </svg>
          {continueAt.label}
        </a>
        .
      </p>
    </div>
  );
}
