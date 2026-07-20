package com.madsbuch.tally.healthconnect

import android.app.Activity
import android.content.Intent
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

@InvokeArg
class ReadSessionsArgs {
    var startMs: Long = 0
    var endMs: Long = 0
}

@TauriPlugin
class HealthConnectPlugin(private val activity: Activity) : Plugin(activity) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Lazy so Health Connect classes are only touched on devices that use them.
    private val readPermissions: Set<String> by lazy {
        setOf(
            HealthPermission.getReadPermission(ExerciseSessionRecord::class),
            HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(DistanceRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
        )
    }

    private fun sdkAvailability(): Int =
        if (Build.VERSION.SDK_INT < 26) HealthConnectClient.SDK_UNAVAILABLE
        else HealthConnectClient.getSdkStatus(activity.applicationContext)

    private fun client(): HealthConnectClient =
        HealthConnectClient.getOrCreate(activity.applicationContext)

    @Command
    fun getStatus(invoke: Invoke) {
        val availability = when (sdkAvailability()) {
            HealthConnectClient.SDK_AVAILABLE -> "available"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "updateRequired"
            else -> "unavailable"
        }
        if (availability != "available") {
            val res = JSObject()
            res.put("availability", availability)
            res.put("permissionsGranted", false)
            invoke.resolve(res)
            return
        }
        scope.launch {
            try {
                val granted = client().permissionController.getGrantedPermissions()
                val res = JSObject()
                res.put("availability", "available")
                res.put("permissionsGranted", granted.containsAll(readPermissions))
                invoke.resolve(res)
            } catch (e: Exception) {
                invoke.reject("Could not query Health Connect permissions: ${e.message}")
            }
        }
    }

    // Named to avoid clashing with the base Plugin.requestPermissions override.
    @Command
    fun requestHealthPermissions(invoke: Invoke) {
        if (sdkAvailability() != HealthConnectClient.SDK_AVAILABLE) {
            invoke.reject("Health Connect is not available on this device")
            return
        }
        try {
            val contract = PermissionController.createRequestPermissionResultContract()
            val intent = contract.createIntent(activity, readPermissions)
            startActivityForResult(invoke, intent, "onPermissionResult")
        } catch (e: Exception) {
            invoke.reject("Could not launch the Health Connect permission request: ${e.message}")
        }
    }

    @ActivityCallback
    fun onPermissionResult(invoke: Invoke, result: ActivityResult) {
        // Re-query granted permissions rather than parsing the activity result —
        // Health Connect is the source of truth either way.
        scope.launch {
            try {
                val granted = client().permissionController.getGrantedPermissions()
                val res = JSObject()
                res.put("granted", granted.containsAll(readPermissions))
                invoke.resolve(res)
            } catch (e: Exception) {
                invoke.reject("Could not verify Health Connect permissions: ${e.message}")
            }
        }
    }

    @Command
    fun openSettings(invoke: Invoke) {
        try {
            activity.startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not open Health Connect settings: ${e.message}")
        }
    }

    @Command
    fun readExerciseSessions(invoke: Invoke) {
        val args = invoke.parseArgs(ReadSessionsArgs::class.java)
        if (sdkAvailability() != HealthConnectClient.SDK_AVAILABLE) {
            invoke.reject("Health Connect is not available on this device")
            return
        }
        scope.launch {
            try {
                val hc = client()
                val filter = TimeRangeFilter.between(
                    Instant.ofEpochMilli(args.startMs),
                    Instant.ofEpochMilli(args.endMs),
                )
                val records = mutableListOf<ExerciseSessionRecord>()
                var pageToken: String? = null
                do {
                    val response = hc.readRecords(
                        ReadRecordsRequest(
                            recordType = ExerciseSessionRecord::class,
                            timeRangeFilter = filter,
                            pageSize = 100,
                            pageToken = pageToken,
                        )
                    )
                    records += response.records
                    pageToken = response.pageToken
                } while (pageToken != null)

                val sessions = JSArray()
                for (record in records) sessions.put(sessionToJson(hc, record))
                val res = JSObject()
                res.put("sessions", sessions)
                invoke.resolve(res)
            } catch (e: SecurityException) {
                invoke.reject("Missing Health Connect permissions: ${e.message}")
            } catch (e: Exception) {
                invoke.reject("Could not read exercise sessions: ${e.message}")
            }
        }
    }

    private suspend fun sessionToJson(
        hc: HealthConnectClient,
        s: ExerciseSessionRecord,
    ): JSObject {
        var calories: Double? = null
        var distanceMeters: Double? = null
        var avgHeartRate: Double? = null
        try {
            val agg = hc.aggregate(
                AggregateRequest(
                    metrics = setOf(
                        ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL,
                        TotalCaloriesBurnedRecord.ENERGY_TOTAL,
                        DistanceRecord.DISTANCE_TOTAL,
                        HeartRateRecord.BPM_AVG,
                    ),
                    timeRangeFilter = TimeRangeFilter.between(s.startTime, s.endTime),
                )
            )
            calories = agg[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
                ?: agg[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.inKilocalories
            distanceMeters = agg[DistanceRecord.DISTANCE_TOTAL]?.inMeters
            avgHeartRate = agg[HeartRateRecord.BPM_AVG]?.toDouble()
        } catch (_: Exception) {
            // Aggregation is best-effort — a session without granular data still counts.
        }

        val obj = JSObject()
        obj.put("id", s.metadata.id)
        s.title?.takeIf { it.isNotBlank() }?.let { obj.put("title", it) }
        obj.put("exerciseType", exerciseTypeName(s.exerciseType))
        obj.put("startMs", s.startTime.toEpochMilli())
        obj.put("endMs", s.endTime.toEpochMilli())
        calories?.let { obj.put("calories", it) }
        distanceMeters?.let { obj.put("distanceMeters", it) }
        avgHeartRate?.let { obj.put("avgHeartRate", it) }
        obj.put("sourcePackage", s.metadata.dataOrigin.packageName)
        return obj
    }

    private fun exerciseTypeName(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "Badminton"
        ExerciseSessionRecord.EXERCISE_TYPE_BASEBALL -> "Baseball"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL -> "Basketball"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "Biking"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "Indoor biking"
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP -> "Boot camp"
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING -> "Boxing"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "Calisthenics"
        ExerciseSessionRecord.EXERCISE_TYPE_CRICKET -> "Cricket"
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> "Dancing"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "Elliptical"
        ExerciseSessionRecord.EXERCISE_TYPE_EXERCISE_CLASS -> "Exercise class"
        ExerciseSessionRecord.EXERCISE_TYPE_FENCING -> "Fencing"
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AMERICAN -> "American football"
        ExerciseSessionRecord.EXERCISE_TYPE_FOOTBALL_AUSTRALIAN -> "Australian football"
        ExerciseSessionRecord.EXERCISE_TYPE_FRISBEE_DISC -> "Frisbee"
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF -> "Golf"
        ExerciseSessionRecord.EXERCISE_TYPE_GUIDED_BREATHING -> "Breathwork"
        ExerciseSessionRecord.EXERCISE_TYPE_GYMNASTICS -> "Gymnastics"
        ExerciseSessionRecord.EXERCISE_TYPE_HANDBALL -> "Handball"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "HIIT"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "Hiking"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_HOCKEY -> "Ice hockey"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING -> "Ice skating"
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "Martial arts"
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING -> "Paddling"
        ExerciseSessionRecord.EXERCISE_TYPE_PARAGLIDING -> "Paragliding"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "Pilates"
        ExerciseSessionRecord.EXERCISE_TYPE_RACQUETBALL -> "Racquetball"
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING -> "Rock climbing"
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY -> "Roller hockey"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING -> "Rowing"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "Rowing machine"
        ExerciseSessionRecord.EXERCISE_TYPE_RUGBY -> "Rugby"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "Running"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "Treadmill running"
        ExerciseSessionRecord.EXERCISE_TYPE_SAILING -> "Sailing"
        ExerciseSessionRecord.EXERCISE_TYPE_SCUBA_DIVING -> "Scuba diving"
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING -> "Skating"
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING -> "Skiing"
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING -> "Snowboarding"
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWSHOEING -> "Snowshoeing"
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER -> "Soccer"
        ExerciseSessionRecord.EXERCISE_TYPE_SOFTBALL -> "Softball"
        ExerciseSessionRecord.EXERCISE_TYPE_SQUASH -> "Squash"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING -> "Stair climbing"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE -> "Stair machine"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "Strength training"
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING -> "Stretching"
        ExerciseSessionRecord.EXERCISE_TYPE_SURFING -> "Surfing"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "Open water swimming"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "Pool swimming"
        ExerciseSessionRecord.EXERCISE_TYPE_TABLE_TENNIS -> "Table tennis"
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS -> "Tennis"
        ExerciseSessionRecord.EXERCISE_TYPE_VOLLEYBALL -> "Volleyball"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "Walking"
        ExerciseSessionRecord.EXERCISE_TYPE_WATER_POLO -> "Water polo"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "Weightlifting"
        ExerciseSessionRecord.EXERCISE_TYPE_WHEELCHAIR -> "Wheelchair"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "Yoga"
        else -> "Workout"
    }
}
