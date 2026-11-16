#ifndef SYSTEM_COMMANDS_H
#define SYSTEM_COMMANDS_H

#include <Arduino.h>

enum SessionMode : uint8_t {
    SESSION_MODE_WRIST = 0,
    SESSION_MODE_BALANCE_STATIC = 1,
    SESSION_MODE_BALANCE_DYNAMIC = 2
};

enum OrientationFlag : uint8_t {
    ORIENT_FLAG_NONE      = 0x00,
    ORIENT_FLAG_INVERT_X  = 0x01,
    ORIENT_FLAG_INVERT_Y  = 0x02,
    ORIENT_FLAG_SWAP_AXES = 0x04
};

enum SysCommand {
    CMD_NONE = 0,
    CMD_START_SESSION,
    CMD_STOP_SESSION,
    CMD_REBOOT,
    CMD_SWITCH_MODE,
    CMD_RECALIBRATE,
    CMD_DELETE_PATIENT,
    CMD_DELETE_SESSION,
    CMD_SYNC_ORIENTATION,
    CMD_SET_TARE
};

struct SysCommandMsg {
    SysCommand cmd;
    char patientId[64]; // Max 63 characters + null terminator
    int sessionId;      // For single session delete
    uint8_t sessionMode;
    uint8_t orientationFlags;
    bool hasOrientation;
    bool hasTare;
    float tareRoll;
    float tarePitch;
};

// Global queue handle for sending system commands from WebServer to main loop
extern QueueHandle_t sysCommandQueue;

#endif // SYSTEM_COMMANDS_H
