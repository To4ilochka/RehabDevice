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
    
    // Получение текущего UNIX времени с системных часов ESP32
    time_t now = time(nullptr);
    sessionStartUnix = (now > 1000000) ? now : (sessionStartTimeMs / 1000);
    
    Serial.printf("[AnalyticsEngine] Старт сессии для пациента '%s', время: %s\n", 
                  patientId.c_str(), getFormattedDateTime().c_str());
}

bool AnalyticsEngine::stopSession(MemoryFS* fs) {
    if (!sessionActive) return false;

    SessionRecord record = getCurrentRecord();
    sessionActive = false;

    Serial.printf("[AnalyticsEngine] Завершение сессии. Сгибаний: %d, Плавность: %.1f%%, Удержание: %.1f с\n", 
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
    if (dt <= 0.0001f) return; // Защита от деления на ноль при слишком частых вызовах
    lastUpdateMs = nowMs;

    // В качестве основного угла поворота кисти используем крен (roll), либо наклон (pitch)
    currentAngle = data.roll;

    // Обновление глобального минимума и максимума за сессию
    if (currentAngle < minAngle) minAngle = currentAngle;
    if (currentAngle > maxAngle) maxAngle = currentAngle;

    // Расчет средней скорости (по модулю вектора угловой скорости гироскопа)
    float currentSpeed = sqrt(data.gyroX * data.gyroX + data.gyroY * data.gyroY + data.gyroZ * data.gyroZ);
    totalSpeedSum += currentSpeed;
    speedSamplesCount++;

    // Детекция тремора / резких рывков (по угловому ускорению d(omega)/dt)
    float angularJerk = fabs(currentSpeed - lastGyroDegS) / dt;
    lastGyroDegS = currentSpeed;

    if (angularJerk > ANALYTICS_TREMOR_JERK_THRESHOLD) {
        tremorSpikesCount++;
        // Плавность уменьшается с каждым резким рывком/тремором
        smoothnessScore = max(0.0f, 100.0f - (tremorSpikesCount * 1.5f));
    }

    // Адаптивный детектор сгибаний с гистерезисом
    if (hystState == STATE_NEUTRAL) {
        localExtremeAngle = currentAngle;
        hystState = STATE_SEARCHING_MAX;
    } else if (hystState == STATE_SEARCHING_MAX) {
        if (currentAngle > localExtremeAngle) {
            localExtremeAngle = currentAngle; // Обновляем локальный максимум
        } else if (currentAngle < localExtremeAngle - ANALYTICS_HYSTERESIS_DEG) {
            // Угол упал ниже порога гистерезиса относительно максимума — фиксируем вершину
            flexionsCount++;
            localExtremeAngle = currentAngle;
            hystState = STATE_SEARCHING_MIN;
        }
    } else if (hystState == STATE_SEARCHING_MIN) {
        if (currentAngle < localExtremeAngle) {
            localExtremeAngle = currentAngle; // Обновляем локальный минимум
        } else if (currentAngle > localExtremeAngle + ANALYTICS_HYSTERESIS_DEG) {
            // Угол вырос выше порога гистерезиса относительно минимума — фиксируем дно
            flexionsCount++;
            localExtremeAngle = currentAngle;
            hystState = STATE_SEARCHING_MAX;
        }
    }

    // Подсчет времени удержания в крайних точках
    // (если кисть находится в пределах допуска возле локального экстремума и скорость мала)
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
        // Если время еще не синхронизировано, возвращаем время со старта в секундах
        unsigned long elapsedSec = (millis() - sessionStartTimeMs) / 1000;
        return "Сессия (+" + String(elapsedSec) + " с)";
    }
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    char buf[64];
    strftime(buf, sizeof(buf), "%d.%m.%Y %H:%M:%S", &timeinfo);
    return String(buf);
}
