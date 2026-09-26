/**
 * Help that stays out of the way until it's wanted.
 *
 * Explanations were written inline, as grey paragraphs under the thing they
 * explained. Read once, they are clutter every day after — and they pushed the
 * numbers people actually open the app for further down the screen. So an ⓘ
 * sits next to the heading instead, and the words live in a sheet behind it.
 *
 * The rule of thumb for what belongs in here: anything true of the app rather
 * than of today. "Net kcal means eaten minus burned" is help; "3 days have
 * nothing logged" is the state of your week and stays on the screen.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useSheetHistory } from "../lib/sheetHistory";

function InfoSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useSheetHistory(true, onClose);
  // Rendered at the body rather than where the ⓘ sits: an icon next to a
  // heading would otherwise hand the sheet that heading's styling, and a
  // section title is uppercase — the help came out SHOUTING.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2 className="sheet-title">{title}</h2>
        <div className="info-body">{children}</div>
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary btn-block" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** An ⓘ next to a heading; `children` is what it says when tapped. */
export default function InfoButton({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="info-btn"
        aria-label={`About ${title.toLowerCase()}`}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9.25" />
          <path d="M12 10.5v6" strokeLinecap="round" />
          <circle cx="12" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <InfoSheet title={title} onClose={() => setOpen(false)}>
          {children}
        </InfoSheet>
      )}
    </>
  );
}
