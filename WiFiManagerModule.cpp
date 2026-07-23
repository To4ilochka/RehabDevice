#include "WiFiManagerModule.h"

WiFiManagerModule::WiFiManagerModule() : apIP(192, 168, 4, 1) {}

bool WiFiManagerModule::init() {
    Serial.println("[WiFiManager] Configuring Wi-Fi in SoftAP mode...");
    
    WiFi.mode(WIFI_AP);
    
    if (!WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0))) {
        Serial.println("[WiFiManager] Error setting IP configuration for Access Point!");
        return false;
    }

    if (!WiFi.softAP(WIFI_AP_SSID, WIFI_AP_PASSWORD, WIFI_AP_CHANNEL, 0, WIFI_AP_MAX_CONNECTIONS)) {
        Serial.println("[WiFiManager] Error starting WiFi SoftAP!");
        return false;
    }

    // Start DNS server redirecting all domains (*) to AP IP for Captive Portal
    dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
    dnsServer.start(DNS_SERVER_PORT, "*", apIP);

    Serial.printf("[WiFiManager] SoftAP started successfully!\n");
    Serial.printf("             SSID: %s\n", WIFI_AP_SSID);
    Serial.printf("             Password: %s\n", WIFI_AP_PASSWORD);
    Serial.printf("             IP & Captive Portal: %s\n", WiFi.softAPIP().toString().c_str());

    return true;
}

void WiFiManagerModule::update() {
    dnsServer.processNextRequest();
}

int WiFiManagerModule::getConnectedClientsCount() const {
    return WiFi.softAPgetStationNum();
}
