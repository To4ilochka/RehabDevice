#include "AnalyticsEngine.h"
#include "AngleMath.h"
#include <time.h>
#include <math.h>
#include <ArduinoJson.h>

AnalyticsEngine::AnalyticsEngine()
    : sessionActive(false),
      sessionMode(SESSION_MODE_WRIST),
      invertX(false),
      invertY(false),
      swapAxes(false),
      tareRoll(0.0f),
      tarePitch(0.0f),
      skipStepDelta(false),
      speedSamplesCount(0) {
    mutex = xSemaphoreCreateRecursiveMutex();
    if (mutex == nullptr) {
        Serial.println("[AnalyticsEngine] FATAL: Failed to create state mutex!");
    }
    reset();
}

AnalyticsEngine::~AnalyticsEngine() {
    if (mutex != nullptr) {
        vSemaphoreDelete(mutex);
    }
}

void AnalyticsEngine::reset() {
    minAngle = INFINITY;
    maxAngle = -INFINITY;
    minPitch = INFINITY;
    maxPitch = -INFINITY;
    currentAngle = 0.0f;
    previousRoll = 0.0f;
    totalWeightSec = 0.0f;
    sumRoll = 0.0f;
    sumPitch = 0.0f;
    sumRollSq = 0.0f;
    sumPitchSq = 0.0f;
    neutralHoldSec = 0.0f;
    quadrantActiveSec = 0.0f;
    quadFLSec = 0.0f;
    quadFRSec = 0.0f;
    quadBLSec = 0.0f;
    quadBRSec = 0.0f;
    totalSpeedSum = 0.0f;
    speedSamplesCount = 0;
    lastGyroDegS = 0.0f;
    activeMotionSec = 0.0f;
    tremorSpikesCount = 0;
    smoothnessScore = 100.0f;
    hystState = STATE_NEUTRAL;
    localExtremeAngle = 0.0f;
    flexionsCount = 0;
    skipStepDelta = false;
    lastUpdateMs = millis();
}

void AnalyticsEngine::startSession(const String& patientName, uint8_t mode) {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    reset();
    sessionMode = (mode <= SESSION_MODE_BALANCE_DYNAMIC) ? mode : SESSION_MODE_WRIST;
    patientId = patientName;
    sessionActive = true;
    sessionStartTimeMs = millis();
    lastUpdateMs = millis();
    
    // Get current UNIX time from ESP32 system RTC
    time_t now = time(nullptr);
    sessionStartUnix = (now > 1000000) ? now : (sessionStartTimeMs / 1000);
    
    Serial.printf("[AnalyticsEngine] Session started for patient '%s' (mode=%u), time: %s\n", 
                  patientId.c_str(), static_cast<unsigned>(sessionMode), getFormattedDateTime().c_str());
    xSemaphoreGiveRecursive(mutex);
}

bool AnalyticsEngine::stopSession() {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    if (!sessionActive) {
        xSemaphoreGiveRecursive(mutex);
        return false;
    }

    SessionRecord record = getCurrentRecord();
    sessionActive = false;

    Serial.printf("[AnalyticsEngine] Session stopped (mode=%u). Amp/Span: %.1f, SwayRMS: %.1f, Smoothness: %.1f%%, Duration: %.1f s\n", 
                  static_cast<unsigned>(record.sessionMode), record.amplitude, record.swayRms, record.smoothness, record.sessionDuration);
    xSemaphoreGiveRecursive(mutex);
    return true;
}

void AnalyticsEngine::setOrientation(bool invertXAxis, bool invertYAxis, bool swapXYAxes) {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    if (invertX != invertXAxis || invertY != invertYAxis || swapAxes != swapXYAxes) {
        invertX = invertXAxis;
        invertY = invertYAxis;
        swapAxes = swapXYAxes;
        skipStepDelta = true;
    }
    xSemaphoreGiveRecursive(mutex);
}

void AnalyticsEngine::setTare(float rollTareDeg, float pitchTareDeg) {
    if (!isfinite(rollTareDeg) || !isfinite(pitchTareDeg)) return;
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    tareRoll = rollTareDeg;
    tarePitch = pitchTareDeg;
    skipStepDelta = true;
    xSemaphoreGiveRecursive(mutex);
}

void AnalyticsEngine::resetTare() {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    tareRoll = 0.0f;
    tarePitch = 0.0f;
    skipStepDelta = true;
    xSemaphoreGiveRecursive(mutex);
}

void AnalyticsEngine::processData(const MPUData& data) {
    if (!data.dataUpdated || !isfinite(data.roll) || !isfinite(data.pitch)) return;
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    if (!sessionActive) {
        xSemaphoreGiveRecursive(mutex);
        return;
    }

    unsigned long nowMs = millis();
    float dt = (nowMs - lastUpdateMs) / 1000.0f;
    if (dt <= 0.0001f) {
        xSemaphoreGiveRecursive(mutex);
        return; // Prevent division by zero if called too frequently
    }
    lastUpdateMs = nowMs;
    const float stepDt = fminf(dt, 0.25f);

    const TiltPair mapped = mapAxisOrientation(data.roll, data.pitch, invertX, invertY, swapAxes);
    const TiltPair eff = applyTiltTare(mapped, tareRoll, tarePitch);
    const bool skipDelta = data.recalibrated || skipStepDelta;
    skipStepDelta = false;

    float currentSpeed = 0.0f;

    if (sessionMode == SESSION_MODE_WRIST) {
        // Use wrist roll angle as primary movement metric; skip step delta when zero-offset or orientation just changed
        if (speedSamplesCount == 0) {
            currentAngle = eff.roll;
        } else if (!skipDelta) {
            currentAngle += normalizeAngleDifference(eff.roll - previousRoll);
        }
        previousRoll = eff.roll;

        // Update session global minimum and maximum
        if (currentAngle < minAngle) minAngle = currentAngle;
        if (currentAngle > maxAngle) maxAngle = currentAngle;

        // Calculate 3-axis angular velocity magnitude for open-chain wrist articulation
        currentSpeed = sqrtf(data.gyroX * data.gyroX + data.gyroY * data.gyroY + data.gyroZ * data.gyroZ);

        // Adaptive flexions detector with hysteresis
        if (hystState == STATE_NEUTRAL) {
            localExtremeAngle = currentAngle;
            hystState = STATE_SEARCHING_MAX;
        } else if (hystState == STATE_SEARCHING_MAX) {
            if (currentAngle > localExtremeAngle) {
                localExtremeAngle = currentAngle; // Update local peak
            } else if (currentAngle < localExtremeAngle - ANALYTICS_HYSTERESIS_DEG) {
                flexionsCount++;
                localExtremeAngle = currentAngle;
                hystState = STATE_SEARCHING_MIN;
            }
        } else if (hystState == STATE_SEARCHING_MIN) {
            if (currentAngle < localExtremeAngle) {
                localExtremeAngle = currentAngle; // Update local valley
            } else if (currentAngle > localExtremeAngle + ANALYTICS_HYSTERESIS_DEG) {
                flexionsCount++;
                localExtremeAngle = currentAngle;
                hystState = STATE_SEARCHING_MAX;
            }
        }
    } else {
        // 4-Way Balance Biomechanics (Static Hold & Dynamic Multi-Directional Control)
        currentAngle = eff.roll;
        previousRoll = eff.roll;

        if (eff.roll < minAngle) minAngle = eff.roll;
        if (eff.roll > maxAngle) maxAngle = eff.roll;
        if (eff.pitch < minPitch) minPitch = eff.pitch;
        if (eff.pitch > maxPitch) maxPitch = eff.pitch;

        totalWeightSec += stepDt;
        sumRoll += eff.roll * stepDt;
        sumPitch += eff.pitch * stepDt;
        sumRollSq += (eff.roll * eff.roll) * stepDt;
        sumPitchSq += (eff.pitch * eff.pitch) * stepDt;

        const float tiltRadiusDeg = hypotf(eff.roll, eff.pitch);
        if (tiltRadiusDeg <= BALANCE_NEUTRAL_RADIUS_DEG) {
            neutralHoldSec += stepDt;
        }
        if (tiltRadiusDeg > BALANCE_QUADRANT_DEADZONE_DEG) {
            quadrantActiveSec += stepDt;
            if (eff.pitch >= 0.0f) {
                if (eff.roll < 0.0f) quadFLSec += stepDt;
                else quadFRSec += stepDt;
            } else {
                if (eff.roll < 0.0f) quadBLSec += stepDt;
                else quadBRSec += stepDt;
            }
        }

        // Planar tilt angular velocity (excluding vertical floor yaw spin gyroZ)
        currentSpeed = hypotf(data.gyroX, data.gyroY);
    }

    totalSpeedSum += currentSpeed;
    speedSamplesCount++;
    activeMotionSec += stepDt;

    // Duration-normalized jerk/tremor smoothness across all protocols
    if (speedSamplesCount > 1 && !skipDelta) {
        const float angularJerk = fabsf(currentSpeed - lastGyroDegS) / dt;
        if (angularJerk > ANALYTICS_TREMOR_JERK_THRESHOLD) {
            tremorSpikesCount++;
        }
    }
    lastGyroDegS = currentSpeed;

    const float effectiveWindowSec = fmaxf(activeMotionSec, 5.0f);
    const float spikesPerMin = (static_cast<float>(tremorSpikesCount) / effectiveWindowSec) * 60.0f;
    smoothnessScore = fmaxf(0.0f, fminf(100.0f, 100.0f - (spikesPerMin * 1.5f)));

    xSemaphoreGiveRecursive(mutex);
}

bool AnalyticsEngine::isSessionActive() const {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    bool active = sessionActive;
    xSemaphoreGiveRecursive(mutex);
    return active;
}

uint8_t AnalyticsEngine::getSessionMode() const {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    uint8_t mode = sessionMode;
    xSemaphoreGiveRecursive(mutex);
    return mode;
}

SessionRecord AnalyticsEngine::getCurrentRecord() const {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    SessionRecord record;
    memset(&record, 0, sizeof(SessionRecord)); // zero initialize
    strncpy(record.patientId, patientId.c_str(), sizeof(record.patientId) - 1);
    record.timestamp = sessionStartUnix;
    String dateStr = (const_cast<AnalyticsEngine*>(this))->getFormattedDateTime();
    strncpy(record.dateStr, dateStr.c_str(), sizeof(record.dateStr) - 1);
    record.sessionMode = sessionMode;
    record.minAngle = isinf(minAngle) ? 0.0f : minAngle;
    record.maxAngle = isinf(maxAngle) ? 0.0f : maxAngle;
    record.avgSpeed = (speedSamplesCount > 0) ? (totalSpeedSum / speedSamplesCount) : 0.0f;
    record.smoothness = smoothnessScore;
    record.sessionDuration = sessionActive ? ((millis() - sessionStartTimeMs) / 1000.0f) : 0.0f;

    if (sessionMode == SESSION_MODE_WRIST) {
        record.amplitude = record.maxAngle - record.minAngle;
        record.flexionsCount = flexionsCount;
    } else {
        record.minPitch = isinf(minPitch) ? 0.0f : minPitch;
        record.maxPitch = isinf(maxPitch) ? 0.0f : maxPitch;
        const float mlSpan = record.maxAngle - record.minAngle;
        const float apSpan = record.maxPitch - record.minPitch;
        record.amplitude = (mlSpan + apSpan) * 0.5f;
        record.flexionsCount = 0;

        if (totalWeightSec > 0.0f) {
            record.meanRoll = sumRoll / totalWeightSec;
            record.meanPitch = sumPitch / totalWeightSec;
            record.mlRms = sqrtf(sumRollSq / totalWeightSec);
            record.apRms = sqrtf(sumPitchSq / totalWeightSec);
            record.swayRms = sqrtf((sumRollSq + sumPitchSq) / totalWeightSec);
            record.stabilityPct = fminf(100.0f, fmaxf(0.0f, (neutralHoldSec / totalWeightSec) * 100.0f));
        }
        if (quadrantActiveSec > 0.0f) {
            record.qFL = (quadFLSec / quadrantActiveSec) * 100.0f;
            record.qFR = (quadFRSec / quadrantActiveSec) * 100.0f;
            record.qBL = (quadBLSec / quadrantActiveSec) * 100.0f;
            record.qBR = (quadBRSec / quadrantActiveSec) * 100.0f;
        }
    }

    xSemaphoreGiveRecursive(mutex);
    return record;
}

String AnalyticsEngine::getLiveStatsJSON() {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    SessionRecord rec = getCurrentRecord();
    JsonDocument doc;
    
    doc["type"] = "liveStats";
    doc["active"] = sessionActive;
    doc["patientId"] = patientId;
    doc["sessionMode"] = rec.sessionMode;
    doc["minAngle"] = serialized(String(rec.minAngle, 1));
    doc["maxAngle"] = serialized(String(rec.maxAngle, 1));
    doc["amplitude"] = serialized(String(rec.amplitude, 1));
    doc["avgSpeed"] = serialized(String(rec.avgSpeed, 1));
    doc["smoothness"] = serialized(String(rec.smoothness, 1));
    doc["flexionsCount"] = rec.flexionsCount;
    doc["sessionDuration"] = serialized(String(rec.sessionDuration, 1));

    if (rec.sessionMode != SESSION_MODE_WRIST) {
        const float symPct = computeQuadrantSymmetryPct(rec.qFL, rec.qFR, rec.qBL, rec.qBR);
        doc["minPitch"] = serialized(String(rec.minPitch, 1));
        doc["maxPitch"] = serialized(String(rec.maxPitch, 1));
        doc["meanRoll"] = serialized(String(rec.meanRoll, 1));
        doc["meanPitch"] = serialized(String(rec.meanPitch, 1));
        doc["swayRms"] = serialized(String(rec.swayRms, 1));
        doc["mlRms"] = serialized(String(rec.mlRms, 1));
        doc["apRms"] = serialized(String(rec.apRms, 1));
        doc["stabilityPct"] = serialized(String(rec.stabilityPct, 1));
        doc["qFL"] = serialized(String(rec.qFL, 1));
        doc["qFR"] = serialized(String(rec.qFR, 1));
        doc["qBL"] = serialized(String(rec.qBL, 1));
        doc["qBR"] = serialized(String(rec.qBR, 1));
        doc["symmetryPct"] = serialized(String(symPct, 1));
    }

    String jsonStr;
    serializeJson(doc, jsonStr);
    xSemaphoreGiveRecursive(mutex);
    return jsonStr;
}

String AnalyticsEngine::getFormattedDateTime() {
    time_t now = time(nullptr);
    if (now < 1000000) {
        unsigned long elapsedSec = (millis() - sessionStartTimeMs) / 1000;
        return "Сесія (+" + String(elapsedSec) + " с)";
    }
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    char buf[64];
    strftime(buf, sizeof(buf), "%d.%m.%Y %H:%M:%S", &timeinfo);
    return String(buf);
}
