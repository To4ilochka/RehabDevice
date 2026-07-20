#include "WebServerModule.h"

// Резервный встроенный HTML интерфейс (на случай, если файлы не загружены в LittleFS)
static const char FALLBACK_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>RehabDevice</title>
<style>body{background:#0a0e17;color:#fff;font-family:sans-serif;text-align:center;padding:50px;}
.box{border:1px solid #00f2fe;padding:30px;border-radius:16px;max-width:500px;margin:0 auto;}
h1{color:#00f2fe;}</style></head>
<body><div class="box"><h1>🚀 RehabDevice Підключено!</h1>
<p>Внутрішня файлова система (LittleFS) ще не прошита файлами веб-інтерфейсу з теки /data.</p>
<p>Будь ласка, завантажте файли index.html, style.css та app.js через інструмент LittleFS Upload.</p></div></body></html>
)rawliteral";

WebServerModule::WebServerModule(SensorMPU* sensorPtr, MemoryFS* fsPtr, AnalyticsEngine* analyticsPtr, WiFiManagerModule* wifiPtr)
    : server(WEB_SERVER_PORT), ws("/ws"), sensor(sensorPtr), memoryFS(fsPtr), analytics(analyticsPtr), wifi(wifiPtr),
      lastStatusBroadcastMs(0), lastStatsBroadcastMs(0), lastCleanupMs(0), sendInitialStatusClientId(0) {}

void WebServerModule::init() {
    Serial.println("[WebServer] Инициализация Async Web Server и WebSocket...");

    // Настройка обработчиков WebSocket
    ws.onEvent([this](AsyncWebSocket* s, AsyncWebSocketClient* c, AwsEventType type, void* arg, uint8_t* d, size_t len) {
        this->onWsEvent(s, c, type, arg, d, len);
    });
    server.addHandler(&ws);

    // Настройка маршрутов
    setupRoutes();

    // Запуск сервера
    server.begin();
    Serial.println("[WebServer] Веб-сервер успешно запущен на порту 80!");
}

void WebServerModule::setupRoutes() {
    // ================================================================
    // ОСНОВНЫЕ МАРШРУТЫ
    // ================================================================

    // Главная страница (Captive portal или прямой доступ)
    auto serveIndex = [this](AsyncWebServerRequest *request) {
        Serial.printf("[HTTP] GET %s from %s Host: %s\n", request->url().c_str(), request->client()->remoteIP().toString().c_str(), request->host().c_str());
        if (LittleFS.exists("/index.html")) {
            request->send(LittleFS, "/index.html", "text/html");
        } else {
            request->send_P(200, "text/html", FALLBACK_HTML);
        }
    };
    server.on("/", HTTP_GET, serveIndex);
    server.on("/index.html", HTTP_GET, serveIndex);

    server.on("/style.css", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /style.css");
        if (LittleFS.exists("/style.css")) {
            request->send(LittleFS, "/style.css", "text/css");
        } else {
            request->send(404, "text/plain", "CSS not found");
        }
    });

    server.on("/app.js", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /app.js");
        if (LittleFS.exists("/app.js")) {
            request->send(LittleFS, "/app.js", "application/javascript");
        } else {
            request->send(404, "text/plain", "JS not found");
        }
    });

    // Экспорт статистики в CSV файл
    server.on("/download.csv", HTTP_GET, [this](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /download.csv");
        String csvData = memoryFS->generateCSV();
        AsyncWebServerResponse *response = request->beginResponse(200, "text/csv; charset=utf-8", csvData);
        response->addHeader("Content-Disposition", "attachment; filename=\"Rehab_Patient_Statistics.csv\"");
        request->send(response);
    });

    // ================================================================
    // HTTP API
    // ================================================================

    // Статус системи: пам'ять, стан сесії, поточний кут
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /api/status");
        size_t total = memoryFS->getTotalBytes();
        size_t used = memoryFS->getUsedBytes();
        bool active = analytics->isSessionActive();
        SessionRecord rec = analytics->getCurrentRecord();
        MPUData mpu = sensor->getData();

        char buf[384];
        snprintf(buf, sizeof(buf),
                 "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":%u,\"totalBytes\":%u,"
                 "\"sessionActive\":%s,\"patientId\":\"%s\",\"angle\":%.2f}",
                 wifi->getConnectedClientsCount(), (unsigned int)used, (unsigned int)total,
                 active ? "true" : "false", rec.patientId.c_str(), mpu.roll);
        request->send(200, "application/json", buf);
    });

    // Список сесій — повний JSON
    server.on("/api/sessions", HTTP_GET, [this](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /api/sessions");
        String json = memoryFS->getSessionsJSON();
        request->send(200, "application/json", json);
    });

    // Виконання команд через HTTP GET
    server.on("/api/cmd", HTTP_GET, [this](AsyncWebServerRequest *request) {
        String action = request->hasArg("action") ? request->arg("action") : "";
        Serial.printf("[HTTP] GET /api/cmd?action=%s\n", action.c_str());

        if (action == "syncTime") {
            unsigned long ts = request->arg("timestamp").toInt();
            if (ts > 1000000000UL) {
                struct timeval tv = { .tv_sec = (time_t)ts, .tv_usec = 0 };
                settimeofday(&tv, NULL);
            }
        } else if (action == "startSession") {
            String patientId = request->hasArg("patientId") ? request->arg("patientId") : "";
            if (patientId.length() > 0) {
                analytics->startSession(patientId);
            }
        } else if (action == "stopSession") {
            analytics->stopSession(memoryFS);
        } else if (action == "recalibrate") {
            sensor->recalibrate();
        } else if (action == "deleteSession") {
            String filename = request->hasArg("filename") ? request->arg("filename") : "";
            memoryFS->deleteSession(filename);
        } else if (action == "deletePatient") {
            String patientId = request->hasArg("patientId") ? request->arg("patientId") : "";
            memoryFS->deletePatient(patientId);
        }

        request->send(200, "application/json", "{\"ok\":true}");
    });

    // Маршруты для перенаправления Captive Portal (Android / iOS / Windows)
    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /generate_204 (captive portal redirect)");
        request->redirect("http://192.168.4.1/");
    });
    server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /fwlink (captive portal redirect)");
        request->redirect("http://192.168.4.1/");
    });
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest *request) {
        Serial.println("[HTTP] GET /hotspot-detect.html (captive portal redirect)");
        request->redirect("http://192.168.4.1/");
    });

    // Обработчик 404 с автоматическим редиректом на Captive Portal или главную страницу (для /diag и старых ссылок)
    server.onNotFound([](AsyncWebServerRequest *request) {
        Serial.printf("[HTTP] 404/redirect: %s %s Host: %s\n", request->methodToString(), request->url().c_str(), request->host().c_str());
        if (!request->host().equalsIgnoreCase(WiFi.softAPIP().toString()) || !request->url().startsWith("/api/")) {
            request->redirect("http://" + WiFi.softAPIP().toString() + "/");
        } else {
            request->send(404, "text/plain", "404: Not Found");
        }
    });
}

void WebServerModule::onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
                                void* arg, uint8_t* data, size_t len) {
    if (type == WS_EVT_CONNECT) {
        Serial.printf("[WebSocket] Клиент #%u подключился с IP: %s\n", client->id(), client->remoteIP().toString().c_str());
        // Выставляем ID клиента для безопасной отправки начального статуса из цикла loop на Core 1
        sendInitialStatusClientId = client->id();
    } else if (type == WS_EVT_DISCONNECT) {
        Serial.printf("[WebSocket] Клиент #%u отключился\n", client->id());
    } else if (type == WS_EVT_DATA) {
        handleWebSocketMessage(client, data, len);
    }
}

void WebServerModule::handleWebSocketMessage(AsyncWebSocketClient* client, uint8_t* data, size_t len) {
    DynamicJsonDocument doc(1024);
    DeserializationError error = deserializeJson(doc, data, len);
    if (error) {
        Serial.println("[WebSocket] Ошибка парсинга входящего JSON");
        return;
    }

    String cmd = doc["cmd"].as<String>();

    if (cmd == "syncTime") {
        unsigned long unixTime = doc["timestamp"].as<unsigned long>();
        if (unixTime > 1000000000UL) {
            struct timeval tv = { .tv_sec = (time_t)unixTime, .tv_usec = 0 };
            settimeofday(&tv, NULL);
            Serial.printf("[WebServer] Время синхронизировано через WebSocket: %lu\n", unixTime);
        }
    } else if (cmd == "startSession") {
        String patientId = doc["patientId"].as<String>();
        analytics->startSession(patientId);
        broadcastStatus();
    } else if (cmd == "stopSession") {
        analytics->stopSession(memoryFS);
        broadcastStatus();
        sendSessionsList();
    } else if (cmd == "recalibrate") {
        sensor->recalibrate();
    } else if (cmd == "getSessions") {
        sendSessionsList(client);
    } else if (cmd == "deleteSession") {
        String filename = doc["filename"].as<String>();
        memoryFS->deleteSession(filename);
        sendSessionsList();
        broadcastStatus();
    } else if (cmd == "deletePatient") {
        String patientId = doc["patientId"].as<String>();
        memoryFS->deletePatient(patientId);
        sendSessionsList();
        broadcastStatus();
    } else if (cmd == "rebuildIndex") {
        memoryFS->rebuildIndex();
        sendSessionsList();
        broadcastStatus();
    }
}

void WebServerModule::broadcastAngle(float angle) {
    if (ws.count() == 0) return;

    char buf[64];
    snprintf(buf, sizeof(buf), "{\"type\":\"angle\",\"angle\":%.2f}", angle);
    ws.textAll(buf);
}

void WebServerModule::broadcastStatus() {
    unsigned long now = millis();
    if (now - lastStatusBroadcastMs < STATUS_UPDATE_INTERVAL_MS && lastStatusBroadcastMs != 0) return;
    lastStatusBroadcastMs = now;

    if (ws.count() == 0) return;

    size_t total = memoryFS->getTotalBytes();
    size_t used = memoryFS->getUsedBytes();
    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();

    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":%u,\"totalBytes\":%u,\"sessionActive\":%s,\"patientId\":\"%s\"}",
             wifi->getConnectedClientsCount(), (unsigned int)used, (unsigned int)total,
             active ? "true" : "false", rec.patientId.c_str());
    ws.textAll(buf);
}

void WebServerModule::broadcastLiveStats() {
    if (!analytics->isSessionActive() || ws.count() == 0) return;

    unsigned long now = millis();
    if (now - lastStatsBroadcastMs < 200) return; // Обновление живой статистики 5 раз в секунду
    lastStatsBroadcastMs = now;

    String liveJson = analytics->getLiveStatsJSON();
    // Внедряем поле type
    liveJson.replace("{\"active\"", "{\"type\":\"liveStats\",\"active\"");
    ws.textAll(liveJson);
}

void WebServerModule::sendSessionsList(AsyncWebSocketClient* client) {
    if (ws.count() == 0 && !client) return;
    streamState.active = true;
    streamState.clientId = client ? client->id() : 0;
    streamState.headerSent = false;
    streamState.currentPatientIdx = 0;
}

void WebServerModule::update() {
    // 1. Отправка начального статуса новому подключившемуся клиенту с Core 1 (без блокировки Core 0 / LwIP)
    if (sendInitialStatusClientId != 0) {
        AsyncWebSocketClient* client = ws.client(sendInitialStatusClientId);
        if (client && client->status() == WS_CONNECTED) {
            if (client->canSend()) {
                sendStatusToClient(client);
                sendInitialStatusClientId = 0;
            }
        } else {
            sendInitialStatusClientId = 0;
        }
    }

    // 2. Пошаговая (ровно один чанк за один проход loop) неблокирующая выдача сессий
    if (!streamState.active) return;

    AsyncWebSocketClient* client = nullptr;
    if (streamState.clientId != 0) {
        client = ws.client(streamState.clientId);
        if (!client || client->status() != WS_CONNECTED) {
            streamState.active = false;
            return;
        }
        if (!client->canSend()) {
            // Сокет LwIP прямо сейчас отправляет предыдущий пакет в Wi-Fi эфир.
            // МГНОВЕННО выходим из update() обратно в loop(), гарантируя 0 мс задержки MPU6050!
            return;
        }
    }

    if (!streamState.headerSent) {
        size_t totalPatients = memoryFS->getPatientsCount();
        char startBuf[128];
        snprintf(startBuf, sizeof(startBuf), "{\"type\":\"sessionsStreamStart\",\"totalPatients\":%u}", (unsigned int)totalPatients);
        if (client) client->text(startBuf); else ws.textAll(startBuf);
        streamState.headerSent = true;
        streamState.currentPatientIdx = 0;
        return;
    }

    String chunkJson;
    if (memoryFS->getPatientSessionsChunk(streamState.currentPatientIdx, chunkJson)) {
        if (client) client->text(chunkJson); else ws.textAll(chunkJson);
        streamState.currentPatientIdx++;
    } else {
        // Все пациенты и их сессии выданы
        char endBuf[128];
        snprintf(endBuf, sizeof(endBuf), "{\"type\":\"sessionsStreamEnd\",\"totalSent\":%u}", (unsigned int)streamState.currentPatientIdx);
        if (client) client->text(endBuf); else ws.textAll(endBuf);
        streamState.active = false;
    }
}

void WebServerModule::sendStatusToClient(AsyncWebSocketClient* client) {
    if (!client || client->status() != WS_CONNECTED) return;

    size_t total = memoryFS->getTotalBytes();
    size_t used = memoryFS->getUsedBytes();
    bool active = analytics->isSessionActive();
    SessionRecord rec = analytics->getCurrentRecord();

    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"status\",\"connectedClients\":%d,\"usedBytes\":%u,\"totalBytes\":%u,\"sessionActive\":%s,\"patientId\":\"%s\"}",
             wifi->getConnectedClientsCount(), (unsigned int)used, (unsigned int)total,
             active ? "true" : "false", rec.patientId.c_str());
    client->text(buf);
}

void WebServerModule::cleanupClients() {
    unsigned long now = millis();
    if (now - lastCleanupMs < 2000 && lastCleanupMs != 0) return;
    lastCleanupMs = now;
    ws.cleanupClients();
}
