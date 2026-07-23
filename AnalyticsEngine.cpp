#include "AnalyticsEngine.h"
#include <time.h>

AnalyticsEngine::AnalyticsEngine() : sessionActive(false), speedSamplesCount(0) {
    reset();
}

void AnalyticsEngine::reset() {
    minAngle = 9999.0f;
    maxAngle = -9999.0f;
    currentAngle = 0.0f;
    totalSpeedSum = 0.0f;
    speedSamplesCount = 0;
    lastGyroDegS = 0.0f;
    tremorSpikesCount = 0;
    smoothnessScore = 100.0f;
    hystState = STATE_NEUTRAL;
    localExtremeAngle = 0.0f;
    flexionsCount = 0;
    totalHoldingTimeSec = 0.0f;
    lastUpdateMs = millis();
}

void AnalyticsEngine::startSession(const String& patientName) {
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
}

bool AnalyticsEngine::stopSession(MemoryFS* fs) {
    if (!sessionActive) return false;

    SessionRecord record = getCurrentRecord();
    sessionActive = false;

    Serial.printf("[AnalyticsEngine] Session stopped. Flexions: %d, Smoothness: %.1f%%, Holding: %.1f s\n", 
                  record.flexionsCount, record.smoothness, record.holdingTime);

    if (fs) {
        return fs->saveSession(record);
    }
    return false;
}

void AnalyticsEngine::processData(const MPUData& data) {
    if (!sessionActive || !data.dataUpdated) return;

    unsigned long nowMs = millis();
    float dt = (nowMs - lastUpdateMs) / 1000.0f;
    if (dt <= 0.0001f) return; // Prevent division by zero if called too frequently
    lastUpdateMs = nowMs;

    // Use wrist roll angle as primary movement metric
    currentAngle = data.roll;

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

    // Calculate holding time at extreme points
    if (fabs(currentAngle - localExtremeAngle) <= ANALYTICS_HOLD_TOLERANCE_DEG && 
        currentSpeed <= ANALYTICS_HOLD_MAX_SPEED_DEG_S) {
        totalHoldingTimeSec += dt;
    }
}

bool AnalyticsEngine::isSessionActive() const {
    return sessionActive;
}

SessionRecord AnalyticsEngine::getCurrentRecord() const {
    SessionRecord record;
    record.patientId = patientId;
    record.timestamp = sessionStartUnix;
    record.dateStr = (const_cast<AnalyticsEngine*>(this))->getFormattedDateTime();
    record.minAngle = (minAngle == 9999.0f) ? 0.0f : minAngle;
    record.maxAngle = (maxAngle == -9999.0f) ? 0.0f : maxAngle;
    record.amplitude = record.maxAngle - record.minAngle;
    record.avgSpeed = (speedSamplesCount > 0) ? (totalSpeedSum / speedSamplesCount) : 0.0f;
    record.smoothness = smoothnessScore;
    record.flexionsCount = flexionsCount;
    record.holdingTime = totalHoldingTimeSec;
    return record;
}

String AnalyticsEngine::getLiveStatsJSON() {
    SessionRecord rec = getCurrentRecord();
    char buffer[512];
    snprintf(buffer, sizeof(buffer),
             "{\"active\":%s,\"patientId\":\"%s\",\"minAngle\":%.1f,\"maxAngle\":%.1f,\"amplitude\":%.1f,"
             "\"avgSpeed\":%.1f,\"smoothness\":%.1f,\"flexionsCount\":%d,\"holdingTime\":%.1f}",
             sessionActive ? "true" : "false",
             patientId.c_str(),
             rec.minAngle,
             rec.maxAngle,
             rec.amplitude,
             rec.avgSpeed,
             rec.smoothness,
             rec.flexionsCount,
             rec.holdingTime);
    return String(buffer);
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
