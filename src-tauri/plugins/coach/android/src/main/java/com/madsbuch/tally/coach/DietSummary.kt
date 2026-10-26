package com.madsbuch.tally.coach

import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject

/** Mirrors lib/diet.ts for check-ins delivered without a WebView. */
internal object DietSummary {
    private data class Entry(val day: String, val at: Long, val diet: JSONObject?) {
        fun flag(key: String): Boolean? = diet?.opt(key) as? Boolean
        val occasion: String? get() = (diet?.opt("occasion") as? String)?.trim()?.takeIf { it.isNotEmpty() }
        val drinks: Double? get() = (diet?.opt("drinks") as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
    }

    private fun occasions(entries: List<Entry>, kind: String): List<List<Entry>> {
        val groups = mutableListOf<MutableList<Entry>>()
        val named = mutableMapOf<String, MutableList<Entry>>()
        var previous: MutableList<Entry>? = null
        for (e in entries.filter { it.flag(kind) == true }.sortedBy { it.at }) {
            val label = e.occasion
            if (label != null) {
                val group = named[label]
                if (group != null) group.add(e)
                else {
                    val fresh = mutableListOf(e)
                    named[label] = fresh
                    groups.add(fresh)
                }
                previous = null
                continue
            }
            val group = previous
            if (group != null && e.at - group.last().at <= 4 * 3_600_000L && e.at - group.first().at <= 12 * 3_600_000L) {
                group.add(e)
            } else {
                val fresh = mutableListOf(e)
                previous = fresh
                groups.add(fresh)
            }
        }
        return groups
    }

    fun render(db: SQLiteDatabase, day: String): String {
        // The day following the most recent Sunday is this week's Monday.
        var start = day
        while (!CoachDb.isSunday(CoachDb.shiftDay(start, -1))) start = CoachDb.shiftDay(start, -1)
        val end = CoachDb.shiftDay(start, 6)
        val entries = mutableListOf<Entry>()
        try {
            db.rawQuery(
                "SELECT day, eaten_at, diet FROM food_entries WHERE day >= ? AND day <= ? ORDER BY eaten_at",
                arrayOf(CoachDb.shiftDay(start, -1), day),
            ).use { c ->
                while (c.moveToNext()) {
                    val at = CoachDb.parseIso(c.getString(1)) ?: continue
                    val diet = if (c.isNull(2)) null else JSONObject(c.getString(2))
                    entries.add(Entry(c.getString(0), at, diet))
                }
            }
        } catch (_: Exception) {
            // A worker may wake after an update but before its first migration.
            return "Diet observations unavailable; do not infer weekly adherence."
        }
        val week = entries.filter { it.day >= start && it.day <= end }
        val assessed = week.filter { it.flag("main_meal") == true && it.flag("vegetable_forward") != null }
        val unknownMeals = week.count { it.flag("main_meal") == null || (it.flag("main_meal") == true && it.flag("vegetable_forward") == null) }
        val candy = occasions(entries, "candy").filter { it.first().day >= start && it.first().day <= end }
        val alcohol = occasions(entries, "alcohol").filter { it.first().day >= start && it.first().day <= end }
        val drinks = alcohol.flatten()
        return "Diet observations, week $start–$end, ${week.map { it.day }.distinct().size} days logged: " +
            "vegetables main part of ${assessed.count { it.flag("vegetable_forward") == true }}/${assessed.size} assessed main meals ($unknownMeals entries unassessed); " +
            "refined carbs in ${week.count { it.flag("refined_carbs") == true }} entries (${week.count { it.flag("refined_carbs") == null }} unknown); " +
            "candy ${candy.size} occasions (${week.count { it.flag("candy") == null }} unknown entries); " +
            "alcohol ${alcohol.size} occasions (${week.count { it.flag("alcohol") == null }} unknown entries), " +
            "${drinks.sumOf { it.drinks ?: 0.0 }} drinks recorded (${drinks.count { it.drinks == null }} quantities unknown). " +
            "Occasions group logs within four hours, capped at twelve hours, unless explicitly grouped; assigned to their starting day. " +
            "Totals only describe logged food; do not infer that any day is complete."
    }
}
