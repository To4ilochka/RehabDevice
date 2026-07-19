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
      lastStatusBroadcastMs(0), lastStatsBroadcastMs(0) {}

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
    // Главная страница (Captive portal или прямой доступ)
    server.on("/", HTTP_GET, [this](AsyncWebServerRequest *request) {
        if (LittleFS.exists("/index.html")) {
            request->send(LittleFS, "/index.html", "text/html");
        } else {
            request->send_P(200, "text/html", FALLBACK_HTML);
        }
    });

    server.on("/style.css", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (LittleFS.exists("/style.css")) {
            request->send(LittleFS, "/style.css", "text/css");
        } else {
            request->send(404, "text/plain", "CSS not found");
        }
    });

    server.on("/app.js", HTTP_GET, [](AsyncWebServerRequest *request) {
        if (LittleFS.exists("/app.js")) {
            request->send(LittleFS, "/app.js", "application/javascript");
        } else {
            request->send(404, "text/plain", "JS not found");
        }
    });

    // Экспорт статистики в CSV файл
    server.on("/download.csv", HTTP_GET, [this](AsyncWebServerRequest *request) {
        Serial.println("[WebServer] Запрос на скачивание CSV статистики...");
        String csvData = memoryFS->generateCSV();
        AsyncWebServerResponse *response = request->beginResponse(200, "text/csv; charset=utf-8", csvData);
        response->addHeader("Content-Disposition", "attachment; filename=\"Rehab_Patient_Statistics.csv\"");
        request->send(response);
    });

    // Маршруты для перенаправления Captive Portal (Android / iOS / Windows)
    server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->redirect("http://192.168.4.1/");
    });
    server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->redirect("http://192.168.4.1/");
    });
    server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->redirect("http://192.168.4.1/");
    });

    // Обработчик 404 с автоматическим редиректом на Captive Portal
    server.onNotFound([](AsyncWebServerRequest *request) {
        if (!request->host().equalsIgnoreCase(WiFi.softAPIP().toString())) {
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
        // Отправляем текущее состояние сразу при подключении
        broadcastStatus();
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

    auto sender = [this, client](const String& msg) {
        if (client) {
            if (client->status() == WS_CONNECTED) {
                client->text(msg);
            }
        } else {
            ws.textAll(msg);
        }
        yield(); // Микропауза для отправки пакета сетевым стеком LwIP (защита от переполнения TCP-окна)
    };

    memoryFS->streamSessionsToCallback(sender);
}

void WebServerModule::cleanupClients() {
    ws.cleanupClients();
}
