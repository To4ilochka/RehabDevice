#ifndef ANALYTICS_ENGINE_H
#define ANALYTICS_ENGINE_H

#include <Arduino.h>
#include <sys/time.h>
#include "SensorMPU.h"
#include "MemoryFS.h"
#include "Config.h"

// Текущее состояние адаптивного детектора крайних точек
enum HysteresisState {
    STATE_NEUTRAL = 0,
    STATE_SEARCHING_MAX,
    STATE_SEARCHING_MIN
};

class AnalyticsEngine {
public:
    AnalyticsEngine();
    
    // Начало новой сессии отслеживания для конкретного пациента
    void startSession(const String& patientName);
    
    // Завершение сессии и сохранение в LittleFS
    bool stopSession(MemoryFS* fs);
    
    // Обработка новой порции данных от датчика (вызывается из loop при каждом обновлении)
    void processData(const MPUData& data);
    
    // Проверка, активна ли сессия
    bool isSessionActive() const;
    
    // Получение текущей статистики в виде JSON (для отправки по WebSocket)
    String getLiveStatsJSON();
    
    // Получение текущей записи статистики в виде структуры
    SessionRecord getCurrentRecord() const;
    
    // Сброс статистики
    void reset();

private:
    bool sessionActive;
    String patientId;
    unsigned long sessionStartTimeMs;
    unsigned long sessionStartUnix;
    unsigned long lastUpdateMs;

    // Метрики углов
    float minAngle;
    float maxAngle;
    float currentAngle;
    
    // Метрики скорости
    float totalSpeedSum;
    unsigned long speedSamplesCount;
    float lastGyroDegS;
    
    // Метрики плавности и тремора
    unsigned long tremorSpikesCount;
    float smoothnessScore;
    
    // Детектор сгибаний (гистерезис)
    HysteresisState hystState;
    float localExtremeAngle;
    int flexionsCount;
    
    // Время удержания в крайних точках
    float totalHoldingTimeSec;
    
    // Вспомогательный метод для получения текущего форматированного времени
    String getFormattedDateTime();
};

#endif // ANALYTICS_ENGINE_H
