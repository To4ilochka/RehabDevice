#include "AnalyticsEngine.h"
#include "AngleMath.h"
#include <time.h>
#include <math.h>
#include <ArduinoJson.h>

AnalyticsEngine::AnalyticsEngine() : sessionActive(false), speedSamplesCount(0) {
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
    currentAngle = 0.0f;
    previousRoll = 0.0f;
    totalSpeedSum = 0.0f;
    speedSamplesCount = 0;
    lastGyroDegS = 0.0f;
    tremorSpikesCount = 0;
    smoothnessScore = 100.0f;
    hystState = STATE_NEUTRAL;
    localExtremeAngle = 0.0f;
    flexionsCount = 0;
    lastUpdateMs = millis();
}

void AnalyticsEngine::startSession(const String& patientName) {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    reset();
    patientId = patientName;
    sessionActive = true;
    sessionStartTimeMs = millis();
    lastUpdateMs = millis();
    
    // Get current UNIX time from ESP32 system RTC
    time_t now = time(nullptr);
    sessionStartUnix = (now > 1000000) ? now : (sessionStartTimeMs / 1000);
    
    Serial.printf("[AnalyticsEngine] Session started for patient '%s', time: %s\n", 
                  patientId.c_str(), getFormattedDateTime().c_str());
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

    Serial.printf("[AnalyticsEngine] Session stopped. Flexions: %d, Smoothness: %.1f%%, Duration: %.1f s\n", 
                  record.flexionsCount, record.smoothness, record.sessionDuration);
    xSemaphoreGiveRecursive(mutex);
    return true;
}

void AnalyticsEngine::processData(const MPUData& data) {
    if (!data.dataUpdated || !isfinite(data.roll)) return;
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

    // Use wrist roll angle as primary movement metric
    currentAngle = speedSamplesCount == 0 ? data.roll
        : currentAngle + normalizeAngleDifference(data.roll - previousRoll);
    previousRoll = data.roll;

    // Update session global minimum and maximum
    if (currentAngle < minAngle) minAngle = currentAngle;
    if (currentAngle > maxAngle) maxAngle = currentAngle;

    // Calculate angular velocity magnitude from gyro axes
    float currentSpeed = sqrt(data.gyroX * data.gyroX + data.gyroY * data.gyroY + data.gyroZ * data.gyroZ);
    totalSpeedSum += currentSpeed;
    speedSamplesCount++;

    // Detect tremor and sudden jerks via angular acceleration d(omega)/dt
    float angularJerk = fabs(currentSpeed - lastGyroDegS) / dt;
    lastGyroDegS = currentSpeed;

    if (angularJerk > ANALYTICS_TREMOR_JERK_THRESHOLD) {
        tremorSpikesCount++;
        smoothnessScore = max(0.0f, 100.0f - (tremorSpikesCount * 1.5f));
    }

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
    xSemaphoreGiveRecursive(mutex);
}

bool AnalyticsEngine::isSessionActive() const {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    bool active = sessionActive;
    xSemaphoreGiveRecursive(mutex);
    return active;
}

SessionRecord AnalyticsEngine::getCurrentRecord() const {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    SessionRecord record;
    memset(&record, 0, sizeof(SessionRecord)); // zero initialize
    strncpy(record.patientId, patientId.c_str(), sizeof(record.patientId) - 1);
    record.timestamp = sessionStartUnix;
    String dateStr = (const_cast<AnalyticsEngine*>(this))->getFormattedDateTime();
    strncpy(record.dateStr, dateStr.c_str(), sizeof(record.dateStr) - 1);
    record.minAngle = isinf(minAngle) ? 0.0f : minAngle;
    record.maxAngle = isinf(maxAngle) ? 0.0f : maxAngle;
    record.amplitude = record.maxAngle - record.minAngle;
    record.avgSpeed = (speedSamplesCount > 0) ? (totalSpeedSum / speedSamplesCount) : 0.0f;
    record.smoothness = smoothnessScore;
    record.flexionsCount = flexionsCount;
    record.sessionDuration = (millis() - sessionStartTimeMs) / 1000.0f;
    xSemaphoreGiveRecursive(mutex);
    return record;
}

String AnalyticsEngine::getLiveStatsJSON() {
    xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
    SessionRecord rec = getCurrentRecord();
    JsonDocument doc;
    
    doc["active"] = sessionActive;
    doc["patientId"] = patientId;
    doc["minAngle"] = serialized(String(rec.minAngle, 1));
    doc["maxAngle"] = serialized(String(rec.maxAngle, 1));
    doc["amplitude"] = serialized(String(rec.amplitude, 1));
    doc["avgSpeed"] = serialized(String(rec.avgSpeed, 1));
    doc["smoothness"] = serialized(String(rec.smoothness, 1));
    doc["flexionsCount"] = rec.flexionsCount;
    doc["sessionDuration"] = serialized(String(rec.sessionDuration, 1));

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
