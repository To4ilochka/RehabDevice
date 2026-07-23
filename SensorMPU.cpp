#include "SensorMPU.h"

volatile bool SensorMPU::mpuInterrupt = false;

void IRAM_ATTR SensorMPU::dmpDataReadyISR() {
    mpuInterrupt = true;
}

SensorMPU::SensorMPU() : dmpReady(false), mpuIntStatus(0), devStatus(0), packetSize(0), fifoCount(0),
                         pitchOffset(0.0f), rollOffset(0.0f), yawOffset(0.0f) {
    memset(&currentData, 0, sizeof(currentData));
}

bool SensorMPU::init() {
    // Initialize I2C bus at 100 kHz for stability
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    delay(100);
    
    // Check WHO_AM_I register (0x75) to identify chip (MPU6050/6500/clone)
    Wire.beginTransmission(0x68);
    Wire.write(0x75);
    Wire.endTransmission(false);
    Wire.requestFrom((uint8_t)0x68, (uint8_t)1, (uint8_t)true);
    uint8_t whoAmI = Wire.read();
    Serial.printf("[SensorMPU] WHO_AM_I register (0x75) returned ID: 0x%02X\n", whoAmI);

    mpu.initialize();
    delay(50);
    
    bool conn = mpu.testConnection();
    if (!conn && whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73 && whoAmI != 0x98) {
        Serial.printf("[SensorMPU] Error: MPU6050 not found (testConnection=false, whoAmI=0x%02X)!\n", whoAmI);
        return false;
    } else if (!conn) {
        Serial.printf("[SensorMPU] Warning: testConnection() returned false, but chip answered (ID 0x%02X). Continuing...\n", whoAmI);
    }

    Serial.println("[SensorMPU] Loading DMP firmware to MPU6050...");
    devStatus = mpu.dmpInitialize();

    mpu.setXGyroOffset(0);
    mpu.setYGyroOffset(0);
    mpu.setZGyroOffset(0);
    mpu.setZAccelOffset(1688);

    if (devStatus == 0) {
        Serial.println("[SensorMPU] Auto-calibrating gyro and accel...");
        mpu.CalibrateAccel(6);
        mpu.CalibrateGyro(6);
        mpu.PrintActiveOffsets();

        Serial.println("[SensorMPU] Enabling DMP...");
        mpu.setDMPEnabled(true);

        pinMode(PIN_MPU_INT, INPUT);
        attachInterrupt(digitalPinToInterrupt(PIN_MPU_INT), dmpDataReadyISR, RISING);

        mpuIntStatus = mpu.getIntStatus();
        packetSize = mpu.dmpGetFIFOPacketSize();
        dmpReady = true;

        // Switch I2C clock to 400 kHz for high-speed operation in main loop
        Wire.setClock(400000);
        mpu.resetFIFO();
        mpuInterrupt = false;
        fifoCount = 0;

        Serial.println("[SensorMPU] DMP initialized successfully! Ready (400 kHz).");
        return true;
    } else {
        Serial.printf("[SensorMPU] DMP initialization error (code %d)\n", devStatus);
        return false;
    }
}

void SensorMPU::update() {
    if (!dmpReady) return;

    if (!mpuInterrupt && fifoCount < packetSize) {
        return;
    }

    mpuInterrupt = false;
    mpuIntStatus = mpu.getIntStatus();
    fifoCount = mpu.getFIFOCount();

    if ((mpuIntStatus & (0x01 << MPU6050_INTERRUPT_FIFO_OFLOW_BIT)) || fifoCount >= 1024) {
        mpu.resetFIFO();
        fifoCount = 0;
        Serial.println("[SensorMPU] Warning: FIFO overflow, buffer reset!");
        return;
    }

    if ((mpuIntStatus & 0x02) || fifoCount >= packetSize) {
        if (mpu.dmpGetCurrentFIFOPacket(fifoBuffer)) {
            fifoCount = mpu.getFIFOCount();

            mpu.dmpGetQuaternion(&q, fifoBuffer);

            float normSq = q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z;
            if (normSq < 0.5f || normSq > 1.5f || isnan(q.w) || isnan(q.x) || isnan(q.y) || isnan(q.z)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            mpu.dmpGetGravity(&gravity, &q);
            mpu.dmpGetYawPitchRoll(ypr, &q, &gravity);

            int16_t gx, gy, gz, ax, ay, az;
            mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

            float rawYaw = ypr[0] * 180.0f / M_PI;
            float rawPitch = ypr[1] * 180.0f / M_PI;
            float rawRoll = ypr[2] * 180.0f / M_PI;

            if (isnan(rawRoll) || isnan(rawPitch) || isnan(rawYaw)) {
                mpu.resetFIFO();
                fifoCount = 0;
                return;
            }

            currentData.yaw = rawYaw - yawOffset;
            currentData.pitch = rawPitch - pitchOffset;
            currentData.roll = rawRoll - rollOffset;

            // Convert gyro to deg/sec (131 LSB/deg/s) and accel to g (16384 LSB/g)
            currentData.gyroX = gx / 131.0f;
            currentData.gyroY = gy / 131.0f;
            currentData.gyroZ = gz / 131.0f;

            currentData.accelX = ax / 16384.0f;
            currentData.accelY = ay / 16384.0f;
            currentData.accelZ = az / 16384.0f;

            currentData.dataUpdated = true;
            currentData.timestamp = millis();
        }
    }
}

bool SensorMPU::recalibrate() {
    if (!dmpReady) return false;

    Serial.println("[SensorMPU] Performing on-the-fly recalibration...");
    
    mpuInterrupt = false;
    mpu.resetFIFO();

    delay(50);
    uint16_t count = mpu.getFIFOCount();
    while (count < packetSize) {
        delay(10);
        count = mpu.getFIFOCount();
    }

    uint8_t buffer[64];
    if (!mpu.dmpGetCurrentFIFOPacket(buffer)) {
        mpu.resetFIFO();
        return false;
    }
    
    Quaternion tempQ;
    VectorFloat tempGravity;
    float tempYPR[3];
    mpu.dmpGetQuaternion(&tempQ, buffer);
    mpu.dmpGetGravity(&tempGravity, &tempQ);
    mpu.dmpGetYawPitchRoll(tempYPR, &tempQ, &tempGravity);

    if (isnan(tempYPR[0]) || isnan(tempYPR[1]) || isnan(tempYPR[2])) {
        mpu.resetFIFO();
        return false;
    }

    yawOffset = tempYPR[0] * 180.0f / M_PI;
    pitchOffset = tempYPR[1] * 180.0f / M_PI;
    rollOffset = tempYPR[2] * 180.0f / M_PI;

    mpu.resetFIFO();
    mpuInterrupt = false;
    fifoCount = 0;
    Serial.printf("[SensorMPU] Recalibration complete! New offsets: Y=%.2f, P=%.2f, R=%.2f\n", yawOffset, pitchOffset, rollOffset);
    return true;
}

MPUData SensorMPU::getData() {
    MPUData result = currentData;
    currentData.dataUpdated = false;
    return result;
}

bool SensorMPU::isReady() const {
    return dmpReady;
}
