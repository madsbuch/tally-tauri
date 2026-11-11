import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { aiSpendSince, todayStr } from "../lib/db";
import { shiftDay } from "../lib/daystamp";
import { formatUsd } from "../lib/aiCost";

/** Settings' way into the cost center, with the last 30 days at a glance. */
export default function CostCenterLink() {
  const [month, setMonth] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    aiSpendSince(shiftDay(todayStr(), -29))
      .then((s) => {
        if (alive) setMonth(s.requests > 0 ? s.costUsd : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Link
      to="/settings/costs"
      className="list-row"
      style={{ color: "inherit", textDecoration: "none", marginBottom: 12 }}
    >
      <div className="row-main">
        <div className="row-title">Cost center</div>
        <div className="row-sub">
          {month == null
            ? "What the coach, photo diary and the rest spend"
            : `${formatUsd(month)} in the last 30 days`}
        </div>
      </div>
      <div className="row-end faint">›</div>
    </Link>
  );
}
