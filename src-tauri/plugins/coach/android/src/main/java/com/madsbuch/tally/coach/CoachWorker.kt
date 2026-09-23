package com.madsbuch.tally.coach

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar

/**
 * The scheduled check-in: decide whether to speak, and if so, say it.
 *
 * The decision mirrors `src/lib/coachTriggers.ts` exactly — the same triggers,
 * the same salience order, the same cooldowns, the same one-a-day budget. That
 * duplication is the price of running with no JavaScript alive, and it's kept
 * survivable by the fact that the whole decision is plain comparisons over the
 * digest. The prompt is not duplicated: the frontend caches its stable half
 * into the settings table and this only appends the digest and the occasion.
 *
 * Unlike the in-app path this makes a single toolless call. A check-in doesn't
 * need to query anything — the digest is already the answer — and a tool loop
 * out here would mean reimplementing every query tool as well.
 */
internal object CoachWorker {

    private const val ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
    private const val DEFAULT_MODEL = "google/gemini-2.5-flash"
    private const val TIMEOUT_MS = 90_000
    private const val MIN_DAYS_FOR_TREND = 3

    /** Mirrors TRIGGERS in lib/coachTriggers.ts, highest salience first. */
    private data class Trigger(
        val key: String,
        val title: String,
        val salience: Int,
        val cooldownDays: Int,
        val defaultEnabled: Boolean,
        val defaultHour: Int?,
        val defaultThreshold: Double?,
    )

    private val TRIGGERS = listOf(
        Trigger("follow_up_due", "Following up", 50, 1, true, null, null),
        Trigger("target_drift", "Target looks wrong", 40, 7, true, null, 300.0),
        Trigger("sleep_debt", "Sleep debt building", 35, 5, true, null, 7.0),
        Trigger("protein_short", "Protein running low", 30, 5, true, null, 100.0),
        Trigger("streak_risk", "Streak about to break", 20, 1, false, 20, null),
        Trigger("daily_closeout", "Daily close-out", 10, 1, true, 21, null),
    )

    private data class Candidate(val trigger: Trigger, val fact: String)

    class Result(val sent: Boolean, val title: String?, val message: String?)

    private fun enabled(config: JSONObject?, t: Trigger): Boolean =
        if (config != null && config.has("enabled")) {
            config.optBoolean("enabled", t.defaultEnabled)
        } else {
            t.defaultEnabled
        }

    private fun hourOf(config: JSONObject?, t: Trigger): Int =
        config?.optInt("hour", t.defaultHour ?: 0) ?: (t.defaultHour ?: 0)

    private fun thresholdOf(config: JSONObject?, t: Trigger): Double =
        config?.optDouble("threshold", t.defaultThreshold ?: 0.0) ?: (t.defaultThreshold ?: 0.0)

    private fun evaluate(
        t: Trigger,
        d: CoachDb.Digest,
        hour: Int,
        config: JSONObject?,
        due: List<CoachDb.DueFollowUp>,
    ): String? = when (t.key) {
        "follow_up_due" ->
            if (due.isEmpty()) {
                null
            } else {
                val items = due.joinToString("; ") { "\"${it.text}\" (noted for ${it.followUpOn})" }
                "You set yourself a reminder to come back to " +
                    "${if (due.size == 1) "this" else "these"}: $items. " +
                    "Ask how it's going, specifically — not in general terms."
            }
        "target_drift" -> {
            val target = d.todayTarget
            val avg = d.avgNet
            val limit = thresholdOf(config, t)
            if (avg == null || target == null || d.daysLogged < 5) {
                null
            } else {
                val drift = avg - target
                if (Math.abs(drift) <= limit) {
                    null
                } else {
                    "Over the last ${d.daysLogged} logged days they averaged ${Math.round(avg)} kcal net " +
                        "against a ${Math.round(target)} kcal target — ${Math.abs(Math.round(drift))} kcal/day " +
                        "${if (drift > 0) "above" else "below"} it, consistently. " +
                        "Consider whether the target itself is set right."
                }
            }
        }
        "sleep_debt" -> {
            val avg = d.avgSleepH
            val want = thresholdOf(config, t)
            if (avg == null || d.sleepNights < MIN_DAYS_FOR_TREND || avg >= want) {
                null
            } else {
                "Sleep has averaged $avg h across ${d.sleepNights} nights, under the ${fmt(want)} h they want."
            }
        }
        "protein_short" -> {
            val avg = d.avgProteinG
            val floor = thresholdOf(config, t)
            if (avg == null || d.daysLogged < MIN_DAYS_FOR_TREND || avg >= floor) {
                null
            } else {
                "Protein has averaged ${Math.round(avg)} g/day over ${d.daysLogged} logged days, " +
                    "under their ${fmt(floor)} g floor."
            }
        }
        "streak_risk" ->
            if (hour < hourOf(config, t) || d.todayLogged || d.streakCurrent <= 0) {
                null
            } else {
                "Nothing logged today and a ${d.streakCurrent}-day logging streak is about to break."
            }
        "daily_closeout" ->
            if (hour < hourOf(config, t) || d.todayItems == 0) {
                null
            } else {
                "End of ${d.day}. Close the day out: how it went against the target, " +
                    "and one concrete thing for tomorrow."
            }
        else -> null
    }

    private fun fmt(v: Double): String =
        if (v == Math.floor(v)) v.toLong().toString() else v.toString()

    /**
     * Run the check-in. Returns what was sent, or a result with sent = false
     * when nothing was worth saying — which is a normal outcome, not a failure.
     */
    fun run(dbPath: String): Result {
        val db = CoachDb.open(dbPath)
        try {
            val apiKey = CoachDb.setting(db, "openrouter_api_key")
            if (apiKey.isNullOrBlank()) return Result(false, null, null)

            val day = CoachDb.today()
            val digest = CoachDb.digest(db, day)
            val hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)

            val configs: JSONObject = try {
                val raw = CoachDb.setting(db, "coach_triggers")
                if (raw.isNullOrBlank()) JSONObject() else JSONObject(raw)
            } catch (_: Exception) {
                JSONObject()
            }

            val due = CoachDb.dueFollowUps(db, day)

            val candidates = ArrayList<Candidate>()
            for (t in TRIGGERS) {
                val config = configs.optJSONObject(t.key)
                if (!enabled(config, t)) continue
                val fact = evaluate(t, digest, hour, config, due) ?: continue
                candidates.add(Candidate(t, fact))
            }
            if (candidates.isEmpty()) return Result(false, null, null)

            // One check-in a day, whatever fired.
            val longestCooldown = TRIGGERS.maxOf { it.cooldownDays }
            val history = CoachDb.runHistory(db, CoachDb.shiftDay(day, -longestCooldown))
            if (history.any { it.first == day }) return Result(false, null, null)

            val winner = candidates.firstOrNull { c ->
                val since = CoachDb.shiftDay(day, -(c.trigger.cooldownDays - 1))
                history.none { it.second == c.trigger.key && it.first >= since }
            } ?: return Result(false, null, null)

            val system = buildPrompt(db, digest, winner, candidates)
            val message = complete(apiKey, model(db), system) ?: return Result(false, null, null)

            val title = "${winner.trigger.title} · $day"
            val chatId = CoachDb.insertChat(db, title, system, message)
            if (chatId > 0) {
                CoachDb.insertRun(db, winner.trigger.key, day, chatId)
                // Tapping the notification only reopens the app wherever it
                // was; this is what lets it find the check-in (lib/coachInbox.ts).
                CoachDb.putSetting(db, "coach_unread_chat", chatId.toString())
            }
            if (winner.trigger.key == "follow_up_due") {
                CoachDb.clearFollowUps(db, due.map { it.id })
            }
            return Result(true, winner.trigger.title, message)
        } finally {
            try {
                db.close()
            } catch (_: Exception) {
                // Nothing useful to do if closing fails.
            }
        }
    }

    private fun model(db: android.database.sqlite.SQLiteDatabase): String {
        val m = CoachDb.setting(db, "vision_model")
        return if (m.isNullOrBlank()) DEFAULT_MODEL else m
    }

    private fun buildPrompt(
        db: android.database.sqlite.SQLiteDatabase,
        digest: CoachDb.Digest,
        winner: Candidate,
        all: List<Candidate>,
    ): String {
        val prefix = CoachDb.setting(db, "coach_prompt_prefix")
            // The app caches this after every turn and every settings change.
            // If it has never run, a plain persona still beats saying nothing.
            ?: "You are Tally's coach. Be concise, specific, and straight about what the data shows."

        val sb = StringBuilder(prefix)
        sb.append("\n\n## Where they stand right now\n")
        sb.append(digest.render())
        sb.append("\n\n## This check-in\n")
        sb.append(
            "You are opening this conversation yourself — they haven't asked you anything. " +
                "Lead with the point below, in one message.\n",
        )
        sb.append("Reason you're speaking: ").append(winner.fact).append("\n")
        val others = all.filter { it.trigger.key != winner.trigger.key }
        if (others.isNotEmpty()) {
            sb.append("Also true right now, if and only if it's worth weaving in — do not list these:\n")
            for (c in others) sb.append("- ").append(c.fact).append("\n")
        }
        sb.append("Say one useful thing and stop. No greeting, no preamble about checking their data.\n")
        // This run has no tools, so the delivery rules in the cached prefix
        // would send it looking for send_message that isn't there.
        sb.append(
            "\nIMPORTANT: you have no tools available in this run. Reply with the message itself " +
                "as plain markdown and nothing else — no tool calls, no preamble, no sign-off.",
        )
        return sb.toString()
    }

    /** One chat completion. Returns null on any failure — silence beats noise. */
    private fun complete(apiKey: String, model: String, system: String): String? {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Authorization", "Bearer $apiKey")
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("HTTP-Referer", "https://github.com/madsbuch/tally")
                setRequestProperty("X-Title", "Tally")
            }

            val messages = JSONArray()
            messages.put(JSONObject().put("role", "system").put("content", system))
            messages.put(
                JSONObject().put("role", "user").put(
                    "content",
                    "Deliver your check-in now, following the occasion in your instructions.",
                ),
            )
            val body = JSONObject().put("model", model).put("messages", messages)

            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(body.toString()) }

            if (conn.responseCode !in 200..299) return null
            val text = BufferedReader(InputStreamReader(conn.inputStream, "UTF-8")).use {
                it.readText()
            }
            val choices = JSONObject(text).optJSONArray("choices") ?: return null
            val content = choices.optJSONObject(0)?.optJSONObject("message")?.optString("content")
            return if (content.isNullOrBlank()) null else content.trim()
        } catch (e: Exception) {
            android.util.Log.w("Tally", "Coach check-in request failed", e)
            return null
        } finally {
            conn?.disconnect()
        }
    }
}
