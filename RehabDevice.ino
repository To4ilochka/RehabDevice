#include <Arduino.h>
#include "Config.h"
#include "SensorMPU.h"
#include "MemoryFS.h"
#include "AnalyticsEngine.h"
#include "WiFiManagerModule.h"
#include "WebServerModule.h"

// Global firmware module instances
SensorMPU sensor;
MemoryFS memoryFS;
AnalyticsEngine analytics;
WiFiManagerModule wifiManager;
WebServerModule webServer(&sensor, &memoryFS, &analytics, &wifiManager);

// Timer for periodic angle broadcast (~30 FPS)
unsigned long lastWsBroadcastMs = 0;

void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println("====================================================================");
    Serial.println("  RehabDevice — Wrist Rehabilitation Monitoring System (ESP32)");
    Serial.println("====================================================================");

    // 1. Initialize LittleFS storage and memory management
    if (!memoryFS.init()) {
        Serial.println("[Setup] Error: Failed to initialize MemoryFS!");
    }

    // 2. Initialize MPU6050 gyroscope/accelerometer (DMP + INT interrupts)
    if (!sensor.init()) {
        Serial.println("[Setup] WARNING: MPU6050 not initialized! Check wiring and connections.");
    }

    // 3. Initialize Wi-Fi Access Point and Captive Portal DNS server
    if (!wifiManager.init()) {
        Serial.println("[Setup] Error: Failed to initialize WiFiManager!");
    }

    // 4. Start asynchronous HTTP server and WebSockets
    webServer.init();

    Serial.println("====================================================================");
    Serial.println("  System ready! Connect to Wi-Fi network 'RehabDevice_AP'");
    Serial.println("====================================================================");
}

void loop() {
    // 1. Read FIFO packets from sensor via hardware interrupt without blocking
    sensor.update();

    // 2. Process DNS requests for Captive Portal
    wifiManager.update();

    // 3. Clean up disconnected WebSocket clients and process non-blocking session stream queue
    webServer.cleanupClients();
    webServer.update();

    // 4. Retrieve sensor data and compute analytics
    if (sensor.isReady()) {
        MPUData data = sensor.getData();
        if (data.dataUpdated) {
            // Pass angles and velocities to analytics engine for tremor and flexion detection
            analytics.processData(data);

            // Broadcast real-time data to frontend (~30 FPS)
            unsigned long now = millis();
            if (now - lastWsBroadcastMs >= WS_BROADCAST_INTERVAL_MS) {
                lastWsBroadcastMs = now;
                
                // Broadcast current wrist roll angle for visual feedback in browser
                webServer.broadcastAngle(data.roll);
                
                // Broadcast live training metrics if a patient session is active
                webServer.broadcastLiveStats();
            }
        }
    }

    // Periodic status and memory usage broadcast
    webServer.broadcastStatus();
}
