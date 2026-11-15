"use client";

/**
 * A link to Gmail drafts that opens the Gmail APP on a phone.
 *
 * iPhone: `googlegmail://` opens the app (there is no deep link to the Drafts
 * folder, so it lands in the inbox; Drafts is one tap away in the menu). If the
 * app is not installed the page is still visible after a moment, so the web
 * Gmail opens instead. Android: an intent with the web URL as the fallback.
 * Desktop: plain web Gmail in a new tab.
 */
export const GMAIL_DRAFTS_WEB = "https://mail.google.com/mail/u/0/#drafts";

function openGmail(event: React.MouseEvent<HTMLAnchorElement>): void {
  const agent = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(agent);
  if (!ios && !android) return; // desktop: let the normal link open a tab

  event.preventDefault();
  if (android) {
    window.location.href = `intent://#Intent;scheme=googlegmail;package=com.google.android.gm;S.browser_fallback_url=${encodeURIComponent(GMAIL_DRAFTS_WEB)};end`;
    return;
  }
  const started = Date.now();
  window.location.href = "googlegmail://";
  window.setTimeout(() => {
    // Still here and visible: the app did not open (not installed).
    if (document.visibilityState === "visible" && Date.now() - started < 3000) {
      window.location.href = GMAIL_DRAFTS_WEB;
    }
  }, 1500);
}

export function GmailLink({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a href={GMAIL_DRAFTS_WEB} target="_blank" rel="noreferrer" onClick={openGmail} className={className}>
      {children}
    </a>
  );
}
