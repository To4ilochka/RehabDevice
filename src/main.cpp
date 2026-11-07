#include <Arduino.h>
#include <LittleFS.h>
#include "esp_bt.h"
#include "Config.h"
#include "SensorMPU.h"
#include "AnalyticsEngine.h"
#include "WiFiManagerModule.h"
#include "WebServerModule.h"
#include "DatabaseManager.h"
#include "SDManager.h"
#include "SystemCommands.h"

// Global firmware module instances
SensorMPU sensor;
AnalyticsEngine analytics;
WiFiManagerModule wifiManager;
WebServerModule webServer(&sensor, &analytics, &wifiManager);

// FreeRTOS Task and Queue for sensor data
QueueHandle_t mpuDataQueue;
TaskHandle_t sensorTaskHandle = NULL; // Initialized to NULL for safety

QueueHandle_t sysCommandQueue;
TaskHandle_t dbTaskHandle = NULL;

void dbTask(void *pvParameters) {
    SessionRecord rec;
    while (true) {
        if (xQueueReceive(dbQueue, &rec, portMAX_DELAY) == pdTRUE) {
            dbManager.saveSessionDb(rec);
        }
    }
}

void sensorTask(void *pvParameters) {
    uint32_t queueDropCounter = 0;
    unsigned long lastDropLogMs = 0;
    while (true) {
#if MPU_USE_INTERRUPT
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
#else
        const TickType_t pollTicks = pdMS_TO_TICKS(MPU_POLL_INTERVAL_MS);
        vTaskDelay(pollTicks > 0 ? pollTicks : 1);
#endif

        sensor.update();
        if (sensor.isReady()) {
            MPUData data = sensor.getData();
            if (data.dataUpdated) {
                // Send to queue, don't block if full; rate-log drops under pressure
                if (xQueueSend(mpuDataQueue, &data, 0) != pdTRUE) {
                    queueDropCounter++;
                    unsigned long nowMs = millis();
                    if (nowMs - lastDropLogMs >= 5000) {
                        Serial.printf("[SensorTask] WARNING: mpuDataQueue full! Dropped %u samples.\n", queueDropCounter);
                        lastDropLogMs = nowMs;
                    }
                }
            }
        }
    }
}

void setup() {
    // Free up internal RAM reserved for Bluetooth Controller (~110KB)
    esp_bt_mem_release(ESP_BT_MODE_BTDM);

    Serial.begin(115200);
    delay(500);

    Serial.println("====================================================================");
    Serial.println("  RehabDevice — Rehabilitation Monitoring System (ESP32)");
    Serial.println("====================================================================");

    // 1. Initialize LittleFS for web UI and local fallback SQLite storage
    if (!LittleFS.begin()) {
        Serial.println("[Setup] Error: Failed to mount LittleFS! Attempting to format...");
        if (LittleFS.begin(true)) {
            Serial.println("[Setup] LittleFS formatted and mounted successfully.");
        } else {
            Serial.println("[Setup] CRITICAL Error: LittleFS mount failed completely.");
        }
    } else {
        Serial.println("[Setup] LittleFS mounted successfully.");
    }

    // Initialize SD Card
    sdManager.init();

    // Initialize Database (SQLite)
    if (!dbManager.init(sdManager.isAvailable())) {
        Serial.println("[Setup] Error: Failed to initialize DatabaseManager!");
    }

    // 2. Initialize Wi-Fi Access Point
    if (!wifiManager.init()) {
        Serial.println("[Setup] Error: Failed to initialize WiFiManager!");
    }

    // 3. Start asynchronous HTTP server and WebSockets
    webServer.init();

    // 4. Initialize MPU6050 gyroscope/accelerometer
    if (!sensor.init()) {
        Serial.println("[Setup] WARNING: MPU6050 not initialized! Check wiring and connections.");
    }

    // 5. Initialize FreeRTOS Queues and Tasks
    mpuDataQueue = xQueueCreate(100, sizeof(MPUData));
    sysCommandQueue = xQueueCreate(10, sizeof(SysCommandMsg));
    dbQueue = xQueueCreate(10, sizeof(SessionRecord));

    xTaskCreatePinnedToCore(
        sensorTask,       // Task function
        "SensorTask",     // Task name
        4096,             // Stack size
        NULL,             // Parameters
        5,                // Priority
        &sensorTaskHandle,// Task handle
        0                 // Core 0
    );

    xTaskCreatePinnedToCore(
        dbTask,           // Task function
        "DBTask",         // Task name
        8192,             // Expanded 8 KB stack for 23-column SQLite VDBE + SessionRecord
        NULL,             // Parameters
        2,                // Priority (lower than sensor)
        &dbTaskHandle,    // Task handle
        0                 // Core 0
    );

    Serial.println("====================================================================");
    Serial.println("  System ready! Connect to Wi-Fi network 'RehabDevice_AP'");
    Serial.println("====================================================================");
}

void loop() {
    // 1. Process System Commands
    SysCommandMsg msg;
    while (xQueueReceive(sysCommandQueue, &msg, 0) == pdTRUE) {
        if (msg.cmd == CMD_START_SESSION) {
            dbManager.refreshStorageStats();
            if (dbManager.isStorageLowSpace()) {
                Serial.println("[Main] Blocked CMD_START_SESSION: LittleFS free space < 100 KiB without SD card.");
                webServer.broadcastStatus();
                continue;
            }
            if (msg.hasOrientation) {
                analytics.setOrientation(
                    (msg.orientationFlags & ORIENT_FLAG_INVERT_X) != 0,
                    (msg.orientationFlags & ORIENT_FLAG_INVERT_Y) != 0,
                    (msg.orientationFlags & ORIENT_FLAG_SWAP_AXES) != 0
                );
            }
            if (msg.hasTare) {
                analytics.setTare(msg.tareRoll, msg.tarePitch);
            }
            analytics.startSession(String(msg.patientId), msg.sessionMode);
            webServer.broadcastStatus();
        } else if (msg.cmd == CMD_STOP_SESSION) {
            if (analytics.isSessionActive()) {
                SessionRecord rec = analytics.getCurrentRecord();
                analytics.stopSession();
                dbManager.saveSession(rec); // Non-blocking push to dbQueue
            }
            webServer.broadcastStatus();
        } else if (msg.cmd == CMD_RECALIBRATE) {
            sensor.recalibrate();
            analytics.resetTare();
        } else if (msg.cmd == CMD_SYNC_ORIENTATION) {
            if (msg.hasOrientation) {
                analytics.setOrientation(
                    (msg.orientationFlags & ORIENT_FLAG_INVERT_X) != 0,
                    (msg.orientationFlags & ORIENT_FLAG_INVERT_Y) != 0,
                    (msg.orientationFlags & ORIENT_FLAG_SWAP_AXES) != 0
                );
            }
            if (msg.hasTare) {
                analytics.setTare(msg.tareRoll, msg.tarePitch);
            }
        } else if (msg.cmd == CMD_SET_TARE) {
            if (msg.hasTare) {
                analytics.setTare(msg.tareRoll, msg.tarePitch);
            }
        } else if (msg.cmd == CMD_DELETE_PATIENT) {
            dbManager.deletePatient(String(msg.patientId));
            webServer.broadcastStatus();
        } else if (msg.cmd == CMD_DELETE_SESSION) {
            dbManager.deleteSession(msg.sessionId);
            webServer.broadcastStatus();
        }
    }

    // 2. Clean up disconnected WebSocket clients and process non-blocking session stream queue
    webServer.cleanupClients();
    webServer.update();

    // 3. Retrieve sensor data from FreeRTOS queue and compute analytics
    MPUData data;
    static uint32_t packetCounter = 0;
    
    while (xQueueReceive(mpuDataQueue, &data, 0) == pdTRUE) {
        // Pass every packet to analytics engine for accurate biomechanical tracking
        analytics.processData(data);
        
        packetCounter++;
        // Keep the existing decimated WebSocket cadence while carrying both tilt axes.
        if (packetCounter % 5 == 0) {
            webServer.broadcastAngle(data.roll, data.pitch);
            webServer.broadcastLiveStats();
        }
    }

    // Periodic status and memory usage broadcast
    webServer.broadcastStatus();
}
