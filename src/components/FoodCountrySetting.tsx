/**
 * Which country product lookups favour.
 *
 * Open Food Facts is worldwide, and "skyr" or "leverpostej" means different
 * products in different places, so the diary agent searches what's sold here
 * first. "Here" defaults to the phone's region, which is wrong often enough to
 * be worth overriding: a phone set to US English can still be in Denmark.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getSetting, setSetting } from "../lib/db";
import { WORLDWIDE, countryName, deviceCountry } from "../lib/openFoodFacts";
import { SETTING_KEYS } from "../lib/types";

/** ISO 3166-1 alpha-2; names come from the platform, so only the codes live here. */
const ISO_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN " +
  "BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL " +
  "GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM " +
  "JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME " +
  "MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP " +
  "NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD " +
  "SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO " +
  "TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

/** The stored value meaning "follow the phone". */
const AUTOMATIC = "";

export default function FoodCountrySetting() {
  /** null while loading. */
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    getSetting(SETTING_KEYS.foodCountry)
      .then((v) => setValue(v?.trim().toLowerCase() ?? AUTOMATIC))
      .catch(() => setValue(AUTOMATIC));
    return () => {
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  const countries = useMemo(
    () =>
      ISO_CODES.flatMap((code) => {
        const cc = code.toLowerCase();
        const name = countryName(cc);
        return name ? [{ cc, name }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  const device = deviceCountry();
  const deviceName = device ? countryName(device) : null;

  function choose(next: string) {
    setValue(next);
    void setSetting(SETTING_KEYS.foodCountry, next).then(() => {
      setSaved(true);
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 1500);
    });
  }

  return (
    <div className="card">
      <h2 className="card-title">Product lookups</h2>
      <div className="field" style={{ marginBottom: 0 }}>
        <label className="label" htmlFor="food-country">
          Country
        </label>
        <div className="input-row" style={{ alignItems: "center" }}>
          <select
            id="food-country"
            className="input"
            value={value ?? AUTOMATIC}
            disabled={value == null}
            onChange={(e) => choose(e.target.value)}
          >
            <option value={AUTOMATIC}>
              Automatic{deviceName ? ` (${deviceName})` : ""}
            </option>
            <option value={WORLDWIDE}>Worldwide</option>
            {countries.map((c) => (
              <option key={c.cc} value={c.cc}>
                {c.name}
              </option>
            ))}
          </select>
          {saved && (
            <span className="chip chip-accent" style={{ flex: "0 0 auto" }}>
              Saved
            </span>
          )}
        </div>
        <p className="muted small" style={{ margin: "8px 2px 0" }}>
          When you log something packaged, the diary looks its label up in Open
          Food Facts — products sold in this country first, then worldwide — and
          uses the label's numbers for the amount you ate. Automatic follows your
          phone's region.
        </p>
      </div>
    </div>
  );
}
