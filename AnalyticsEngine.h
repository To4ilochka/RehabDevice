#ifndef ANALYTICS_ENGINE_H
#define ANALYTICS_ENGINE_H

#include <Arduino.h>
#include <sys/time.h>
#include "SensorMPU.h"
#include "MemoryFS.h"
#include "Config.h"

// Current state of the adaptive extreme points detector
enum HysteresisState {
    STATE_NEUTRAL = 0,
    STATE_SEARCHING_MAX,
    STATE_SEARCHING_MIN
};

class AnalyticsEngine {
public:
    AnalyticsEngine();
    
    // Start tracking session for a specific patient
    void startSession(const String& patientName);
    
    // Stop tracking session and save record to LittleFS
    bool stopSession(MemoryFS* fs);
    
    // Process new sensor data sample (called from main loop on data update)
    void processData(const MPUData& data);
    
    // Check if a session is currently active
    bool isSessionActive() const;
    
    // Get live session statistics as JSON string for WebSocket broadcast
    String getLiveStatsJSON();
    
    // Get current session record structure
    SessionRecord getCurrentRecord() const;
    
    // Reset internal statistical counters
    void reset();

private:
    bool sessionActive;
    String patientId;
    unsigned long sessionStartTimeMs;
    unsigned long sessionStartUnix;
    unsigned long lastUpdateMs;

    // Angle metrics
    float minAngle;
    float maxAngle;
    float currentAngle;
    
    // Speed metrics
    float totalSpeedSum;
    unsigned long speedSamplesCount;
    float lastGyroDegS;
    
    // Smoothness and tremor metrics
    unsigned long tremorSpikesCount;
    float smoothnessScore;
    
    // Flexions hysteresis detector
    HysteresisState hystState;
    float localExtremeAngle;
    int flexionsCount;
    
    // Holding time at extreme angles
    float totalHoldingTimeSec;
    
    // Helper method to get formatted date/time string
    String getFormattedDateTime();
};

#endif // ANALYTICS_ENGINE_H
