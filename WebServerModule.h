#ifndef WEB_SERVER_MODULE_H
#define WEB_SERVER_MODULE_H

#include <Arduino.h>
#include <ESPAsyncWebServer.h>
#include <AsyncWebSocket.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include "Config.h"
#include "SensorMPU.h"
#include "MemoryFS.h"
#include "AnalyticsEngine.h"
#include "WiFiManagerModule.h"

class WebServerModule {
public:
    WebServerModule(SensorMPU* sensorPtr, MemoryFS* fsPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr);
    
    // Initialize HTTP server routes and WebSocket handlers
    void init();
    
    // Broadcast real-time wrist angle to all connected WebSocket clients
    void broadcastAngle(float angle);
    
    // Broadcast memory usage, connected clients count, and session recording status
    void broadcastStatus();
    
    // Broadcast live training statistics for current session
    void broadcastLiveStats();
    
    // Send patient sessions list chunk by chunk to avoid RAM exhaustion
    void sendSessionsList(AsyncWebSocketClient* client = nullptr);

    // Regular update called from loop() to process non-blocking chunked streaming on Core 1
    void update();

    // Send initial status payload to newly connected client
    void sendStatusToClient(AsyncWebSocketClient* client);

    // Clean up disconnected or timed out WebSocket clients
    void cleanupClients();

private:
    AsyncWebServer server;
    AsyncWebSocket ws;

    SensorMPU* sensor;
    MemoryFS* memoryFS;
    AnalyticsEngine* analytics;
    WiFiManagerModule* wifi;

    unsigned long lastStatusBroadcastMs;
    unsigned long lastStatsBroadcastMs;
    unsigned long lastCleanupMs;

    struct StreamState {
        bool active = false;
        uint32_t clientId = 0;
        size_t currentPatientIdx = 0;
        bool headerSent = false;
    };
    StreamState streamState;
    uint32_t sendInitialStatusClientId;

    void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
                   void* arg, uint8_t* data, size_t len);
    void handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len);

    void setupRoutes();
};

#endif // WEB_SERVER_MODULE_H
