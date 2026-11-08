import { useSyncExternalStore } from "react";
import {
  currentThemePref,
  setThemePref,
  subscribeThemePref,
  type ThemePref,
} from "../lib/theme";

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Settings → Appearance: follow the phone, or pin light or dark. */
export default function ThemeSetting() {
  const pref = useSyncExternalStore(subscribeThemePref, currentThemePref);
  return (
    <div className="card">
      <h2 className="card-title">Theme</h2>
      <div className="seg">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            className={`seg-item${pref === o.value ? " seg-item-active" : ""}`}
            onClick={() => setThemePref(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: "8px 2px 0" }}>
        System follows your phone&apos;s dark mode.
      </p>
    </div>
  );
}
