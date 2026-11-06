#ifndef WEB_SERVER_MODULE_H
#define WEB_SERVER_MODULE_H

#include <Arduino.h>
#include <ESPAsyncWebServer.h>
#include <AsyncWebSocket.h>
#include <ArduinoJson.h>
#include <sys/time.h>
#include "Config.h"
#include "SensorMPU.h"
#include "AnalyticsEngine.h"
#include "WiFiManagerModule.h"

class WebServerModule {
public:
    WebServerModule(SensorMPU* sensorPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr);
    
    // Initialize HTTP server routes and WebSocket handlers
    void init();
    
    // Broadcast real-time wrist tilt to all connected WebSocket clients
    void broadcastAngle(float roll, float pitch);
    
    // Broadcast memory usage, connected clients count, and session recording status
    void broadcastStatus();
    
    // Broadcast live training statistics for current session
    void broadcastLiveStats();
    

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
    AnalyticsEngine* analytics;
    WiFiManagerModule* wifi;

    unsigned long lastStatusBroadcastMs;
    unsigned long lastStatsBroadcastMs;
    unsigned long lastCleanupMs;


    uint32_t sendInitialStatusClientId;

    void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
                   void* arg, uint8_t* data, size_t len);
    

    void handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len);

    void setupRoutes();
};

#endif // WEB_SERVER_MODULE_H
