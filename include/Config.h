#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ============================================================================
// FIRMWARE SETTINGS
// ============================================================================
#define FIRMWARE_VERSION        "v1.0.1"

// ============================================================================
// HARDWARE PIN SETTINGS (ESP-WROOM-32)
// ============================================================================
#define PIN_I2C_SDA             21
#define PIN_I2C_SCL             22
#define PIN_MPU_INT             17  // Hardware interrupt pin from MPU6050 (INT)
#define SD_CS_PIN               5   // SPI Chip Select pin for SD Card Module

// ============================================================================
// MPU6050 SETTINGS
// ============================================================================
#ifndef MPU_USE_INTERRUPT
#define MPU_USE_INTERRUPT       0
#endif
#define MPU_POLL_INTERVAL_MS    5

// ============================================================================
// WI-FI SOFTAP SETTINGS
// ============================================================================
#define WIFI_AP_SSID            "RehabDevice_AP"
#define WIFI_AP_PASSWORD        "rehab1234"
#define WIFI_AP_CHANNEL         1
#define WIFI_AP_MAX_CONNECTIONS 4

#define WEB_SERVER_PORT         80

// ============================================================================
// WEBSOCKET AND DATA STREAMING SETTINGS
// ============================================================================
// Interval for broadcasting memory status and active state (milliseconds)
#define STATUS_UPDATE_INTERVAL_MS 2000

// ============================================================================
// ANALYTICS ENGINE SETTINGS
// ============================================================================
// Minimum angle change to trigger start/end of a flexion (hysteresis threshold)
#define ANALYTICS_HYSTERESIS_DEG          4.0f
// Angular acceleration threshold (d^2(theta)/dt^2) in deg/s^2 for tremor and jerk detection
#define ANALYTICS_TREMOR_JERK_THRESHOLD   300.0f
// Tolerable deviation from peak angle for holding time calculation
#define ANALYTICS_HOLD_TOLERANCE_DEG      3.5f
// Maximum angular velocity (deg/s) below which wrist is considered holding at extreme point
#define ANALYTICS_HOLD_MAX_SPEED_DEG_S    6.0f

// ============================================================================
// LITTLEFS AND STORAGE SETTINGS
// ============================================================================
// Minimum free memory reserve (in bytes); older sessions are deleted when below this limit (100 KB)
#define FS_MIN_FREE_BYTES                 (100 * 1024)
// Directory for storing per-patient session files (.jsonl)
#define FS_SESSIONS_DIR                   "/p"

#endif // CONFIG_H
