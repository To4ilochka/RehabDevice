#ifndef ANALYTICS_ENGINE_H
#define ANALYTICS_ENGINE_H

#include <Arduino.h>
#include <sys/time.h>
#include <freertos/semphr.h>
#include "SensorMPU.h"
#include "Config.h"
#include "SystemCommands.h"

// Current state of the adaptive extreme points detector
enum HysteresisState {
    STATE_NEUTRAL = 0,
    STATE_SEARCHING_MAX,
    STATE_SEARCHING_MIN
};

struct SessionRecord {
    char patientId[64];
    unsigned long timestamp;
    char dateStr[64];
    uint8_t sessionMode;
    float minAngle;
    float maxAngle;
    float amplitude;
    float avgSpeed;
    float smoothness;
    int flexionsCount;
    float sessionDuration;
    // 4-Way Balance Biomechanics
    float minPitch;
    float maxPitch;
    float meanRoll;
    float meanPitch;
    float swayRms;
    float mlRms;
    float apRms;
    float stabilityPct;
    float qFL;
    float qFR;
    float qBL;
    float qBR;
};


class AnalyticsEngine {
public:
    AnalyticsEngine();
    ~AnalyticsEngine();
    
    // Start tracking session for a specific patient and exercise protocol
    void startSession(const String& patientName, uint8_t mode = SESSION_MODE_WRIST);
    
    // Stop tracking session and return record
    bool stopSession();
    
    // Process new sensor data sample (called from main loop on data update)
    void processData(const MPUData& data);

    // Synchronize mounting axis mapping and software tare offsets with browser GameEngine
    void setOrientation(bool invertXAxis, bool invertYAxis, bool swapXYAxes);
    void setTare(float rollTareDeg, float pitchTareDeg);
    void resetTare();
    
    // Check if a session is currently active and retrieve active protocol mode
    bool isSessionActive() const;
    uint8_t getSessionMode() const;
    
    // Get live session statistics as JSON string for WebSocket broadcast
    String getLiveStatsJSON();
    
    // Get current session record structure
    SessionRecord getCurrentRecord() const;
    
    // Reset internal statistical counters
    void reset();

private:
    bool sessionActive;
    uint8_t sessionMode;
    String patientId;
    unsigned long sessionStartTimeMs;
    unsigned long sessionStartUnix;
    unsigned long lastUpdateMs;

    // Synchronized coordinate transform & tare state
    bool invertX;
    bool invertY;
    bool swapAxes;
    float tareRoll;
    float tarePitch;
    bool skipStepDelta;

    // Angle metrics
    float minAngle;
    float maxAngle;
    float minPitch;
    float maxPitch;
    float currentAngle;
    float previousRoll;

    // 4-Way time-weighted postural & quadrant accumulators
    float totalWeightSec;
    float sumRoll;
    float sumPitch;
    float sumRollSq;
    float sumPitchSq;
    float neutralHoldSec;
    float quadrantActiveSec;
    float quadFLSec;
    float quadFRSec;
    float quadBLSec;
    float quadBRSec;
    
    // Speed metrics
    float totalSpeedSum;
    unsigned long speedSamplesCount;
    float lastGyroDegS;
    
    // Smoothness and tremor metrics
    float activeMotionSec;
    unsigned long tremorSpikesCount;
    float smoothnessScore;
    
    // Serializes access to session state: written by the sensor/loop task via
    // processData(), read/written by AsyncWebServer HTTP and WebSocket callbacks
    // which run in a different FreeRTOS task/core.
    mutable SemaphoreHandle_t mutex;

    // Flexions hysteresis detector
    HysteresisState hystState;
    float localExtremeAngle;
    int flexionsCount;
    
    // Helper method to get formatted date/time string
    String getFormattedDateTime();
};

#endif // ANALYTICS_ENGINE_H
