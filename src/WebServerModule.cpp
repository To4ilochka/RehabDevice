#include "WebServerModule.h"
#include <LittleFS.h>
#include "DatabaseManager.h"
#include <ElegantOTA.h>
#include "SystemCommands.h"

// Fallback embedded HTML interface
static const char FALLBACK_HTML[] = R"rawliteral(
<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>RehabDevice Error</title>
<style>body{background:#0a0e17;color:#fff;font-family:sans-serif;text-align:center;padding:50px;}
.box{border:1px solid #ff4c4c;padding:30px;border-radius:16px;max-width:500px;margin:0 auto;}
h1{color:#ff4c4c;}</style></head>
<body><div class="box"><h1>⚠️ Помилка LittleFS</h1>
<p>Системі не вдалося прочитати файли веб-інтерфейсу з пам'яті.</p>
<button onclick="location.reload()" style="padding:10px 20px; background:#ff4c4c; color:#fff; border:none; border-radius:8px; cursor:pointer; margin-top:15px; font-weight:bold;">Оновити сторінку</button>
</div></body></html>
)rawliteral";

WebServerModule::WebServerModule(SensorMPU* sensorPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr)
    : server(WEB_SERVER_PORT), ws("/ws"), sensor(sensorPtr), analytics(analyticsPtr), wifi(wifiPtr),
      lastStatusBroadcastMs(0), lastStatsBroadcastMs(0), lastCleanupMs(0), sendInitialStatusClientId(0) {}

void WebServerModule::init() {
    Serial.println("[WebServer] Initializing Async Web Server and WebSocket...");
    ws.onEvent([this](AsyncWebSocket* s, AsyncWebSocketClient* c, AwsEventType type, void* arg, uint8_t* d, size_t len) {
        this->onWsEvent(s, c, type, arg, d, len);
    });
    server.addHandler(&ws);
    setupRoutes();
    ElegantOTA.begin(&server);
    server.begin();
    Serial.println("[WebServer] HTTP Server started successfully on port 80!");
}

class AsyncChunkedSessionsResponse : public AsyncAbstractResponse {
private:
    sqlite3_stmt* _stmt;
    bool _isDone;
    int _arrayCount;
    bool _isFirstRow;
    JsonDocument _pendingDoc;

public:
    AsyncChunkedSessionsResponse(sqlite3_stmt* stmt, int arrayCount) : _stmt(stmt), _isDone(false), _arrayCount(arrayCount), _isFirstRow(true) {
        _code = 200;
        _contentType = "application/msgpack";
        _sendContentLength = false;
        _chunked = true;
    }

    ~AsyncChunkedSessionsResponse() {
        if (_stmt) {
            dbManager.finalizeStatement(_stmt);
            _stmt = nullptr;
        }
    }

    bool _sourceValid() const override {
        return _stmt != nullptr;
    }

    size_t _fillBuffer(uint8_t *buf, size_t maxLen) override {
        if (_isDone && _pendingDoc.isNull()) return 0;

        size_t written = 0;
        
        if (_isFirstRow) {
            _isFirstRow = false;
            if (_arrayCount <= 15) {
                buf[written++] = 0x90 | _arrayCount;
            } else if (_arrayCount <= 65535) {
                buf[written++] = 0xdc;
                buf[written++] = (_arrayCount >> 8) & 0xff;
                buf[written++] = _arrayCount & 0xff;
            } else {
                buf[written++] = 0xdd;
                buf[written++] = (_arrayCount >> 24) & 0xff;
                buf[written++] = (_arrayCount >> 16) & 0xff;
                buf[written++] = (_arrayCount >> 8) & 0xff;
                buf[written++] = _arrayCount & 0xff;
            }
        }

        while (written < maxLen) {
            if (!_pendingDoc.isNull()) {
                size_t needed = measureMsgPack(_pendingDoc);
                if (written + needed > maxLen) {
                    if (written == 0) {
                        if (maxLen < needed) return 0; // Forced stop if buffer too tiny
                    }
                    break;
                }
                written += serializeMsgPack(_pendingDoc, buf + written, maxLen - written);
                _pendingDoc.clear();
            }

            if (_isDone) break;

            JsonDocument doc;
            int rc = dbManager.stepSessionRow(_stmt, doc);
            
            if (rc == SQLITE_ROW) {
                size_t needed = measureMsgPack(doc);
                if (written + needed > maxLen) {
                    _pendingDoc = doc;
                    break;
                }
                
                written += serializeMsgPack(doc, buf + written, maxLen - written);
                
            } else {
                if (rc != SQLITE_DONE) {
                    Serial.printf("[WebServer] SQLite step error: %d\n", rc);
                }
                _isDone = true;
            }
        }
        
        return written;
    }
};

void WebServerModule::setupRoutes() {
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request) {
        bool active = analytics->isSessionActive();
        SessionRecord rec = analytics->getCurrentRecord();
        MPUData mpu = sensor->peekData();
        const float safeRoll = isfinite(mpu.roll) ? mpu.roll : 0.0f;
        const float safePitch = isfinite(mpu.pitch) ? mpu.pitch : 0.0f;
        
        JsonDocument doc;
        doc["type"] = "status";
        doc["connectedClients"] = wifi->getConnectedClientsCount();
        doc["usedBytes"] = 0;
        doc["totalBytes"] = 0;
        doc["sessionActive"] = active;
        doc["patientId"] = rec.patientId;
        doc["angle"] = serialized(String(safeRoll, 2));
        doc["roll"] = safeRoll;
        doc["pitch"] = safePitch;
        doc["sdAvailable"] = dbManager.isSDAvailable();
        doc["sensorMutexMisses"] = sensor->getMutexMissCount();
        
        String response;
        serializeJson(doc, response);
    #ifdef DEBUG_VERBOSE
        Serial.printf("[WebServer] /api/status requested. Free heap: %u\n", ESP.getFreeHeap());
    #endif
        request->send(200, "application/json", response);
    });

    server.on("/api/sessions", HTTP_GET, [](AsyncWebServerRequest *request) {
        int limit = request->hasArg("limit") ? request->arg("limit").toInt() : 50;
        int offset = request->hasArg("offset") ? request->arg("offset").toInt() : 0;
        
        int arrayCount = dbManager.countSessionsPage(limit, offset);
        
        sqlite3_stmt* stmt = dbManager.prepareSessionsQuery(limit, offset);
        if (!stmt) {
            request->send(500, "application/msgpack", "{\"error\":\"Failed to prepare statement\"}");
            return;
        }
        
        AsyncChunkedSessionsResponse* response = new AsyncChunkedSessionsResponse(stmt, arrayCount);
        request->send(response);
    });

    server.on("/api/cmd", HTTP_GET, [this](AsyncWebServerRequest *request) {
        String action = request->hasArg("action") ? request->arg("action") : "";
        if (action == "syncTime") {
            unsigned long ts = request->arg("timestamp").toInt();
            if (ts > 1000000000UL) {
                struct timeval tv = { .tv_sec = (time_t)ts, .tv_usec = 0 };
                settimeofday(&tv, NULL);
            }
        } else if (action == "startSession") {
            if (request->hasArg("patientId") && sysCommandQueue != NULL) {
                SysCommandMsg msg = {};
                msg.cmd = CMD_START_SESSION;
                strncpy(msg.patientId, request->arg("patientId").c_str(), sizeof(msg.patientId) - 1);
                xQueueSend(sysCommandQueue, &msg, 0);
            }
        } else if (action == "stopSession") {
            if (sysCommandQueue != NULL) {
                SysCommandMsg msg = {};
                msg.cmd = CMD_STOP_SESSION;
                xQueueSend(sysCommandQueue, &msg, 0);
            }
        } else if (action == "recalibrate") {
            if (sysCommandQueue != NULL) {
                SysCommandMsg msg = {};
                msg.cmd = CMD_RECALIBRATE;
                xQueueSend(sysCommandQueue, &msg, 0);
            }
        } else if (action == "deletePatient") {
            if (request->hasArg("patientId") && sysCommandQueue != NULL) {
                SysCommandMsg msg = {};
                msg.cmd = CMD_DELETE_PATIENT;
                strncpy(msg.patientId, request->arg("patientId").c_str(), sizeof(msg.patientId) - 1);
                xQueueSend(sysCommandQueue, &msg, 0);
            }
        } else if (action == "deleteSession") {
            if (request->hasArg("id") && sysCommandQueue != NULL) {
                SysCommandMsg msg = {};
                msg.cmd = CMD_DELETE_SESSION;
                msg.sessionId = request->arg("id").toInt();
                xQueueSend(sysCommandQueue, &msg, 0);
            }
        } else if (action == "reboot") {
            request->send(200, "application/json", "{\"ok\":true}");
            // Defer restart to a short-lived task so this AsyncTCP callback isn't blocked
            xTaskCreate([](void*) {
                vTaskDelay(pdMS_TO_TICKS(500));
                ESP.restart();
            }, "RebootTask", 2048, NULL, 1, NULL);
            return;
        }
        request->send(200, "application/json", "{\"ok\":true}");
    });


    server.serveStatic("/", LittleFS, "/")
        .setDefaultFile("index.html")
        .setCacheControl("no-cache, max-age=0, must-revalidate");
    
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[WebServer] Missing static asset: /index.html (also tried .gz)");
        AsyncWebServerResponse* response = request->beginResponse(503, "text/html", FALLBACK_HTML);
        response->addHeader("Cache-Control", "no-store");
        request->send(response);
    });

    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() == HTTP_GET) {
            Serial.printf("[WebServer] GET 404: %s (no route or LittleFS asset)\n", request->url().c_str());
        }
        AsyncWebServerResponse* response = request->beginResponse(404, "text/plain", "404: Not Found");
        response->addHeader("Cache-Control", "no-store");
        request->send(response);
    });
}

void WebServerModule::onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type, void* arg, uint8_t* data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WebServer] WebSocket client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
        sendInitialStatusClientId = client->id();
    } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WebServer] WebSocket client #%u disconnected\n", client->id());
    } else if (type == WS_EVT_DATA) {
        handleWebSocketMessage(client, data, len);
    }
}

void WebServerModule::handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len) {
    JsonDocument doc;
    if (deserializeJson(doc, data, len)) return;
    String cmd = doc["cmd"].as<String>();

    if (cmd == "syncTime") {
        unsigned long unixTime = doc["timestamp"].as<unsigned long>();
        if (unixTime > 1000000000UL) {
            struct timeval tv = { .tv_sec = (time_t)unixTime, .tv_usec = 0 };
            settimeofday(&tv, NULL);
        }
    } else if (cmd == "startSession") {
        const char* patientId = doc["patientId"].as<const char*>();
        if (patientId && sysCommandQueue != NULL) {
            SysCommandMsg msg = {};
            msg.cmd = CMD_START_SESSION;
            strncpy(msg.patientId, patientId, sizeof(msg.patientId) - 1);
            xQueueSend(sysCommandQueue, &msg, 0);
        }
    } else if (cmd == "stopSession") {
        if (sysCommandQueue != NULL) {
            SysCommandMsg msg = {};
            msg.cmd = CMD_STOP_SESSION;
            xQueueSend(sysCommandQueue, &msg, 0);
        }
    } else if (cmd == "recalibrate") {
        if (sysCommandQueue != NULL) {
            SysCommandMsg msg = {};
            msg.cmd = CMD_RECALIBRATE;
            xQueueSend(sysCommandQueue, &msg, 0);
        }
    } else if (cmd == "deletePatient") {
        const char* patientId = doc["patientId"].as<const char*>();
        if (patientId && sysCommandQueue != NULL) {
            SysCommandMsg msg = {};
            msg.cmd = CMD_DELETE_PATIENT;
            strncpy(msg.patientId, patientId, sizeof(msg.patientId) - 1);
            xQueueSend(sysCommandQueue, &msg, 0);
        }
    } else if (cmd == "deleteSession") {
        if (sysCommandQueue != NULL) {
            SysCommandMsg msg = {};
            msg.cmd = CMD_DELETE_SESSION;
            msg.sessionId = doc["id"].as<int>();
            xQueueSend(sysCommandQueue, &msg, 0);
        }
    }
}

void WebServerModule::broadcastAngle(float roll, float pitch) {
    if (ws.count() == 0) return;

    const float safeRoll = isfinite(roll) ? roll : 0.0f;
    const float safePitch = isfinite(pitch) ? pitch : 0.0f;

    char buf[96];
    snprintf(buf, sizeof(buf), "{\"type\":\"angle\",\"angle\":%.2f,\"roll\":%.2f,\"pitch\":%.2f}", safeRoll, safeRoll, safePitch);
    
    for (auto& client : ws.getClients()) {
        if (client.status() == WS_CONNECTED && client.canSend()) {
            client.text(buf);
        }
    }
}

void WebServerModule::broadcastStatus() {
    unsigned long now = millis();
    if (now - lastStatusBroadcastMs < STATUS_UPDATE_INTERVAL_MS && lastStatusBroadcastMs != 0) return;
    lastStatusBroadcastMs = now;
    if (ws.count() == 0) return;

    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();
    
    JsonDocument doc;
    doc["type"] = "status";
    doc["connectedClients"] = wifi->getConnectedClientsCount();
    doc["usedBytes"] = 0;
    doc["totalBytes"] = 0;
    doc["sessionActive"] = active;
    doc["patientId"] = rec.patientId;
    doc["sdAvailable"] = dbManager.isSDAvailable();
    doc["version"] = FIRMWARE_VERSION;
    
    String buf;
    serializeJson(doc, buf);
             
    for (auto& client : ws.getClients()) {
        if (client.status() == WS_CONNECTED && client.canSend()) {
            client.text(buf);
        }
    }
}

void WebServerModule::broadcastLiveStats() {
    if (ws.count() == 0) return;
    unsigned long now = millis();
    if (now - lastStatsBroadcastMs < 200) return;
    lastStatsBroadcastMs = now;

    String liveJson = analytics->getLiveStatsJSON();
    liveJson.replace("{\"active\"", "{\"type\":\"liveStats\",\"active\"");
    
    for (auto& client : ws.getClients()) {
        if (client.status() == WS_CONNECTED && client.canSend()) {
            client.text(liveJson);
        }
    }
}

void WebServerModule::update() {
    // ElegantOTA.loop(); // Temporarily disabled for debugging

    if (sendInitialStatusClientId != 0) {
        AsyncWebSocketClient* client = ws.client(sendInitialStatusClientId);
        if (client && client->status() == WS_CONNECTED && client->canSend()) {
            sendStatusToClient(client);
            sendInitialStatusClientId = 0;
        } else if (!client || client->status() != WS_CONNECTED) {
            sendInitialStatusClientId = 0;
        }
    }
}

void WebServerModule::sendStatusToClient(AsyncWebSocketClient* client) {
    if (!client || client->status() != WS_CONNECTED) return;
    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();
    
    JsonDocument doc;
    doc["type"] = "status";
    doc["connectedClients"] = wifi->getConnectedClientsCount();
    doc["usedBytes"] = 0;
    doc["totalBytes"] = 0;
    doc["sessionActive"] = active;
    doc["patientId"] = rec.patientId;
    doc["sdAvailable"] = dbManager.isSDAvailable();
    doc["version"] = FIRMWARE_VERSION;
    
    String buf;
    serializeJson(doc, buf);
    client->text(buf);
}


void WebServerModule::cleanupClients() {
    unsigned long now = millis();
    if (now - lastCleanupMs < 2000 && lastCleanupMs != 0) return;
    lastCleanupMs = now;
    ws.cleanupClients();
}
