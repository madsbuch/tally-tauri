package com.madsbuch.tally.coach

import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The same SQLite file the app writes, read from Kotlin because the scheduled
 * check-in runs with no WebView alive.
 *
 * Everything here mirrors `src/lib/coach.ts` — the digest in particular has to
 * come out with the same numbers, which is why that side was deliberately kept
 * to plain sums and averages. What is NOT mirrored is the prompt: the frontend
 * caches its clock-independent half into the settings table precisely so this
 * file doesn't have to reimplement stance and memory rendering and then drift.
 *
 * Dates go through Calendar and SimpleDateFormat rather than java.time: minSdk
 * is 24 and java.time needs 26.
 */
internal object CoachDb {

    // -- time ---------------------------------------------------------------

    private fun utcParser(pattern: String) = SimpleDateFormat(pattern, Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    /** Epoch ms for an ISO-8601 UTC timestamp, or null if it won't parse. */
    fun parseIso(value: String?): Long? {
        if (value.isNullOrBlank()) return null
        val patterns = arrayOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")
        for (p in patterns) {
            try {
                return utcParser(p).parse(value)?.time
            } catch (_: Exception) {
                // try the next shape
            }
        }
        return null
    }

    private val dayFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    /** Local day of an epoch instant, matching todayStr() on the JS side. */
    fun localDay(epochMs: Long): String = dayFormat.format(Date(epochMs))

    fun today(): String = localDay(System.currentTimeMillis())

    fun shiftDay(day: String, delta: Int): String {
        val parts = day.split("-")
        val cal = Calendar.getInstance()
        cal.set(
            parts.getOrNull(0)?.toIntOrNull() ?: 1970,
            (parts.getOrNull(1)?.toIntOrNull() ?: 1) - 1,
            parts.getOrNull(2)?.toIntOrNull() ?: 1,
            12, 0, 0,
        )
        cal.add(Calendar.DAY_OF_YEAR, delta)
        return dayFormat.format(cal.time)
    }

    private val isoFormat =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    fun nowIso(): String = isoFormat.format(Date())

    // -- reads --------------------------------------------------------------

    fun open(path: String): SQLiteDatabase =
        SQLiteDatabase.openDatabase(path, null, SQLiteDatabase.OPEN_READWRITE)

    fun setting(db: SQLiteDatabase, key: String): String? {
        db.rawQuery("SELECT value FROM settings WHERE key = ?", arrayOf(key)).use { c ->
            return if (c.moveToFirst()) c.getString(0) else null
        }
    }

    /** Trigger keys fired on or after `sinceDay`, as day→key pairs. */
    fun runHistory(db: SQLiteDatabase, sinceDay: String): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        db.rawQuery(
            "SELECT day, trigger_key FROM coach_runs WHERE day >= ?",
            arrayOf(sinceDay),
        ).use { c ->
            while (c.moveToNext()) out.add(Pair(c.getString(0), c.getString(1)))
        }
        return out
    }

    /** A memory whose reminder has come due on or before `day`. */
    data class DueFollowUp(val id: Long, val text: String, val followUpOn: String)

    fun dueFollowUps(db: SQLiteDatabase, day: String): List<DueFollowUp> {
        val out = ArrayList<DueFollowUp>()
        db.rawQuery(
            "SELECT id, text, follow_up_on FROM coach_memory " +
                "WHERE follow_up_on IS NOT NULL AND follow_up_on <= ? ORDER BY follow_up_on",
            arrayOf(day),
        ).use { c ->
            while (c.moveToNext()) {
                out.add(DueFollowUp(c.getLong(0), c.getString(1), c.getString(2)))
            }
        }
        return out
    }

    /**
     * Take the reminders off. A follow-up fires once and the coach re-arms it
     * from inside the turn if the thing still needs watching — otherwise one
     * it forgot to close would come back every day.
     */
    fun clearFollowUps(db: SQLiteDatabase, ids: List<Long>) {
        if (ids.isEmpty()) return
        val now = nowIso()
        for (id in ids) {
            val stmt = db.compileStatement(
                "UPDATE coach_memory SET follow_up_on = NULL, updated_at = ? WHERE id = ?",
            )
            stmt.bindString(1, now)
            stmt.bindLong(2, id)
            stmt.use { it.executeUpdateDelete() }
        }
    }

    private fun nutrient(json: String?, key: String): Double {
        if (json.isNullOrBlank()) return 0.0
        return try {
            val v = JSONObject(json).optDouble(key, 0.0)
            if (v.isNaN() || v < 0) 0.0 else v
        } catch (_: Exception) {
            0.0
        }
    }

    /**
     * The same shape `buildCoachDigest` produces in TypeScript. Per-day
     * rollups count only days with food logged — an untracked day would
     * otherwise drag every average toward zero and earn a lecture for a week
     * the user simply didn't record.
     */
    fun digest(db: SQLiteDatabase, day: String): Digest {
        val weekStart = shiftDay(day, -6)
        val monthStart = shiftDay(day, -30)

        val kcalByDay = HashMap<String, Double>()
        val proteinByDay = HashMap<String, Double>()
        var todayItems = 0
        var todayKcal = 0.0
        var todayProtein = 0.0
        // By the stamped `day`, not the timestamp: an entry logged abroad keeps
        // the day it was logged on (see src/lib/daystamp.ts). The fallback
        // reads the instant here, for a row somehow left unstamped.
        db.rawQuery(
            "SELECT COALESCE(day, ''), eaten_at, nutrients FROM food_entries WHERE " +
                "COALESCE(day, date(eaten_at, 'localtime')) BETWEEN ? AND ?",
            arrayOf(weekStart, day),
        ).use { c ->
            while (c.moveToNext()) {
                val stamped = c.getString(0)
                val d =
                    if (stamped.isNotEmpty()) stamped
                    else localDay(parseIso(c.getString(1)) ?: continue)
                val kcal = nutrient(c.getString(2), "calories")
                val protein = nutrient(c.getString(2), "protein_g")
                kcalByDay[d] = (kcalByDay[d] ?: 0.0) + kcal
                proteinByDay[d] = (proteinByDay[d] ?: 0.0) + protein
                if (d == day) {
                    todayItems++
                    todayKcal += kcal
                    todayProtein += protein
                }
            }
        }

        val burnedByDay = HashMap<String, Double>()
        var todayBurned = 0.0
        var workouts = 0
        db.rawQuery(
            "SELECT COALESCE(day, ''), performed_at, calories_burned FROM workouts WHERE " +
                "COALESCE(day, date(performed_at, 'localtime')) BETWEEN ? AND ?",
            arrayOf(weekStart, day),
        ).use { c ->
            while (c.moveToNext()) {
                val stamped = c.getString(0)
                val d =
                    if (stamped.isNotEmpty()) stamped
                    else localDay(parseIso(c.getString(1)) ?: continue)
                val kcal = c.getDouble(2)
                burnedByDay[d] = (burnedByDay[d] ?: 0.0) + kcal
                workouts++
                if (d == day) {
                    todayBurned += kcal
                    todayItems++
                }
            }
        }

        val sleepByDay = HashMap<String, Double>()
        db.rawQuery(
            "SELECT COALESCE(day, ''), ended_at, duration_min FROM sleep_sessions WHERE " +
                "COALESCE(day, date(ended_at, 'localtime')) BETWEEN ? AND ?",
            arrayOf(weekStart, day),
        ).use { c ->
            while (c.moveToNext()) {
                val stamped = c.getString(0)
                val d =
                    if (stamped.isNotEmpty()) stamped
                    else localDay(parseIso(c.getString(1)) ?: continue)
                sleepByDay[d] = (sleepByDay[d] ?: 0.0) + c.getDouble(2)
            }
        }

        val steps = ArrayList<Double>()
        val weights = ArrayList<Pair<String, Double>>()
        db.rawQuery(
            "SELECT day, steps, weight_kg FROM health_metrics WHERE day >= ? ORDER BY day",
            arrayOf(monthStart),
        ).use { c ->
            while (c.moveToNext()) {
                val d = c.getString(0)
                if (!c.isNull(1) && d >= weekStart) steps.add(c.getDouble(1))
                if (!c.isNull(2)) weights.add(Pair(d, c.getDouble(2)))
            }
        }

        // Base target plus this day's manual correction, mirroring lib/goals.ts.
        val base = setting(db, "calorie_target_kcal")?.toDoubleOrNull()
        var manual = 0.0
        db.rawQuery(
            "SELECT delta_kcal FROM day_goal_adjustments WHERE day = ?",
            arrayOf(day),
        ).use { c -> if (c.moveToFirst()) manual = c.getDouble(0) }
        val target = if (base != null && base > 0) maxOf(200.0, base + manual) else null

        val loggedDays = kcalByDay.keys.toList()
        val nets = loggedDays.map { (kcalByDay[it] ?: 0.0) - (burnedByDay[it] ?: 0.0) }
        val proteins = loggedDays.map { proteinByDay[it] ?: 0.0 }

        // The streak engine isn't ported: it recomputes from the whole diary
        // with freeze bookkeeping. It mirrors its result into streak_state
        // instead, and a day-stale length is plenty for "about to break".
        var streakCurrent = 0
        try {
            val raw = setting(db, "streak_state")
            if (!raw.isNullOrBlank()) streakCurrent = JSONObject(raw).optInt("current", 0)
        } catch (_: Exception) {
            // Corrupt blob: treat it as no streak.
        }

        var fastHours: Double? = null
        var fastGoal: Double? = null
        db.rawQuery(
            "SELECT started_at, goal_hours FROM fasts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
            null,
        ).use { c ->
            if (c.moveToFirst()) {
                val started = parseIso(c.getString(0))
                if (started != null) {
                    fastHours = round1((System.currentTimeMillis() - started) / 3_600_000.0)
                    fastGoal = c.getDouble(1)
                }
            }
        }

        // Only the newest document, and only its title: the prompt prefix the
        // frontend caches already carries the full library index, so this is
        // just so a check-in can mention a result that landed since.
        var latestDocument: String? = null
        db.rawQuery(
            "SELECT document_date, title FROM documents WHERE status = 'ready' " +
                "AND document_date IS NOT NULL ORDER BY document_date DESC LIMIT 1",
            null,
        ).use { c ->
            if (c.moveToFirst()) latestDocument = "${c.getString(0)}: ${c.getString(1)}"
        }

        val latest = weights.lastOrNull()
        val base7 = weights.firstOrNull { it.first >= weekStart }?.second
        val base30 = weights.firstOrNull { it.first >= monthStart }?.second

        return Digest(
            day = day,
            todayKcalIn = Math.round(todayKcal).toDouble(),
            todayKcalOut = Math.round(todayBurned).toDouble(),
            todayProteinG = Math.round(todayProtein).toDouble(),
            todayTarget = target?.let { Math.round(it).toDouble() },
            todayItems = todayItems,
            daysLogged = loggedDays.size,
            avgNet = nets.averageOrNull(),
            avgProteinG = proteins.averageOrNull(),
            workouts = workouts,
            avgSleepH = sleepByDay.values.toList().averageOrNull()?.let { round1(it / 60.0) },
            sleepNights = sleepByDay.size,
            avgSteps = steps.averageOrNull()?.let { Math.round(it).toDouble() },
            weightKg = latest?.second?.let { round1(it) },
            weight7dKg = if (latest != null && base7 != null) round1(latest.second - base7) else null,
            weight30dKg = if (latest != null && base30 != null) round1(latest.second - base30) else null,
            streakCurrent = streakCurrent,
            todayLogged = todayItems > 0,
            fastHours = fastHours,
            fastGoalHours = fastGoal,
            latestDocument = latestDocument,
        )
    }

    private fun List<Double>.averageOrNull(): Double? =
        if (isEmpty()) null else sum() / size

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0

    // -- writes -------------------------------------------------------------

    /**
     * Save the check-in as a chat the coach opened. The transcript is
     * [system, assistant] — no user message, because the user didn't write
     * one; the frontend renders that as the coach speaking first.
     */
    fun insertChat(db: SQLiteDatabase, title: String, system: String, message: String): Long {
        val messages = JSONArray()
        messages.put(JSONObject().put("role", "system").put("content", system))
        messages.put(
            JSONObject()
                .put("role", "assistant")
                .put(
                    "tool_calls",
                    JSONArray().put(
                        JSONObject()
                            .put("id", "checkin")
                            .put("type", "function")
                            .put(
                                "function",
                                JSONObject()
                                    .put("name", "send_message")
                                    .put(
                                        "arguments",
                                        JSONObject().put("text", message).toString(),
                                    ),
                            ),
                    ),
                )
                .put("content", JSONObject.NULL),
        )
        messages.put(
            JSONObject()
                .put("role", "tool")
                .put("tool_call_id", "checkin")
                .put("content", "Delivered."),
        )

        val now = nowIso()
        val stmt = db.compileStatement(
            "INSERT INTO chats (created_at, updated_at, title, messages) VALUES (?, ?, ?, ?)",
        )
        stmt.bindString(1, now)
        stmt.bindString(2, now)
        stmt.bindString(3, title)
        stmt.bindString(4, messages.toString())
        return stmt.use { it.executeInsert() }
    }

    fun insertRun(db: SQLiteDatabase, triggerKey: String, day: String, chatId: Long) {
        val stmt = db.compileStatement(
            "INSERT INTO coach_runs (trigger_key, day, created_at, chat_id) VALUES (?, ?, ?, ?)",
        )
        stmt.bindString(1, triggerKey)
        stmt.bindString(2, day)
        stmt.bindString(3, nowIso())
        stmt.bindLong(4, chatId)
        stmt.use { it.executeInsert() }
    }

    /** Everything the trigger evaluation and the prompt need from the diary. */
    data class Digest(
        val day: String,
        val todayKcalIn: Double,
        val todayKcalOut: Double,
        val todayProteinG: Double,
        val todayTarget: Double?,
        val todayItems: Int,
        val daysLogged: Int,
        val avgNet: Double?,
        val avgProteinG: Double?,
        val workouts: Int,
        val avgSleepH: Double?,
        val sleepNights: Int,
        val avgSteps: Double?,
        val weightKg: Double?,
        val weight7dKg: Double?,
        val weight30dKg: Double?,
        val streakCurrent: Int,
        val todayLogged: Boolean,
        val fastHours: Double?,
        val fastGoalHours: Double?,
        val latestDocument: String?,
    ) {
        private fun num(v: Double?): String =
            if (v == null) "no data" else if (v == Math.floor(v)) v.toLong().toString() else v.toString()

        /** Mirrors renderCoachDigest() on the TypeScript side. */
        fun render(): String {
            val lines = ArrayList<String>()
            lines.add(
                "Today ($day): ${num(todayKcalIn)} kcal in, ${num(todayKcalOut)} burned, " +
                    "net ${num(todayKcalIn - todayKcalOut)}" +
                    (if (todayTarget != null) " against a ${num(todayTarget)} kcal target" else " (no target set)") +
                    "; ${num(todayProteinG)} g protein; $todayItems items logged.",
            )
            lines.add(
                "Last 7 days: $daysLogged/7 days with food logged, avg net ${num(avgNet)} kcal, " +
                    "avg protein ${num(avgProteinG)} g, $workouts workouts, " +
                    "avg sleep ${num(avgSleepH)} h, avg steps ${num(avgSteps)}.",
            )
            if (weightKg != null) {
                var l = "Weight: ${num(weightKg)} kg"
                if (weight7dKg != null) l += ", ${if (weight7dKg >= 0) "+" else ""}${num(weight7dKg)} kg over 7 days"
                if (weight30dKg != null) l += ", ${if (weight30dKg >= 0) "+" else ""}${num(weight30dKg)} kg over 30 days"
                lines.add("$l.")
            }
            lines.add(
                "Logging streak: $streakCurrent days; today ${if (todayLogged) "is" else "is not"} logged yet.",
            )
            if (fastHours != null && fastGoalHours != null) {
                lines.add("Fasting right now: ${num(fastHours)} h of a ${num(fastGoalHours)} h goal.")
            }
            if (latestDocument != null) {
                lines.add("Most recent document in their library — $latestDocument.")
            }
            return lines.joinToString("\n")
        }
    }
}
