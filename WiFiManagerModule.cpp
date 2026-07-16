#include "WiFiManagerModule.h"

WiFiManagerModule::WiFiManagerModule() : apIP(192, 168, 4, 1) {}

bool WiFiManagerModule::init() {
    Serial.println("[WiFiManager] Настройка Wi-Fi в режиме SoftAP...");
    
    WiFi.mode(WIFI_AP);
    
    // Настройка статического IP-адреса для точки доступа (Captive Portal по умолчанию 192.168.4.1)
    if (!WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0))) {
        Serial.println("[WiFiManager] Ошибка настройки конфигурации IP для точки доступа!");
        return false;
    }

    // Запуск точки доступа с WPA2 шифрованием
    if (!WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD, WIFI_AP_CHANNEL, 0, WIFI_AP_MAX_CONNECTIONS)) {
        Serial.println("[WiFiManager] Ошибка запуска WiFi SoftAP!");
        return false;
    }

    // Запуск DNS сервера с перенаправлением всех доменов (*) на IP точки доступа для работы Captive Portal
    dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
    dnsServer.start(DNS_SERVER_PORT, "*", apIP);

    Serial.printf("[WiFiManager] SoftAP успешно запущена!\n");
    Serial.printf("             SSID: %s\n", WIFI_AP_SSID);
    Serial.printf("             Пароль: %s\n", WIFI_AP_PASSWORD);
    Serial.printf("             IP и Captive Portal: %s\n", WiFi.softAPIP().toString().c_str());

    return true;
}

void WiFiManagerModule::update() {
    // Обработка входящих DNS-запросов и перенаправление на Captive Portal
    dnsServer.processNextRequest();
}

IPAddress WiFiManagerModule::getAPIP() const {
    return apIP;
}

int WiFiManagerModule::getConnectedClientsCount() const {
    return WiFi.softAPgetStationNum();
}
