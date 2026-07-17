#include "SensorMPU.h"

// Инициализация статического флага прерывания
volatile bool SensorMPU::mpuInterrupt = false;

void IRAM_ATTR SensorMPU::dmpDataReadyISR() {
    mpuInterrupt = true;
}

SensorMPU::SensorMPU() : dmpReady(false), mpuIntStatus(0), devStatus(0), packetSize(0), fifoCount(0),
                         pitchOffset(0.0f), rollOffset(0.0f), yawOffset(0.0f) {
    memset(&currentData, 0, sizeof(currentData));
}

bool SensorMPU::init() {
    // Инициализация I2C шины на стандартной надежной скорости 100 кГц
    // (на 400 кГц из-за емкости проводов и резисторов на макетке сигнал часто искажается)
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 100000);
    delay(100); // Даем шине и стабилизатору питания время прийти в норму
    
    // Прямая проверка регистра WHO_AM_I (0x75), чтобы узнать точный ID датчика (MPU6050/6500/клон)
    Wire.beginTransmission(0x68);
    Wire.write(0x75);
    Wire.endTransmission(false);
    Wire.requestFrom((uint8_t)0x68, (uint8_t)1, (uint8_t)true);
    uint8_t whoAmI = Wire.read();
    Serial.printf("[SensorMPU] Чтение регистра WHO_AM_I (0x75) вернуло ID чипа: 0x%02X\n", whoAmI);

    // Инициализация MPU6050 по стандартному адресу 0x68
    mpu.initialize();
    delay(50); // Даем генератору частоты (PLL) датчика время на пробуждение после команды 0x6B
    
    // Проверка соединения с датчиком (если чип MPU6050, 6500 или клон с ID 0x68, 0x70, 0x71, 0x73, 0x98)
    bool conn = mpu.testConnection();
    if (!conn && whoAmI != 0x68 && whoAmI != 0x70 && whoAmI != 0x71 && whoAmI != 0x73 && whoAmI != 0x98) {
        Serial.printf("[SensorMPU] Ошибка: MPU6050 не обнаружен (testConnection=false, whoAmI=0x%02X)!\n", whoAmI);
        return false;
    } else if (!conn) {
        Serial.printf("[SensorMPU] Предупреждение: testConnection() вернул false, но чип ответил (ID 0x%02X). Продолжаем...\n", whoAmI);
    }

    Serial.println("[SensorMPU] Загрузка DMP прошивки в MPU6050...");
    devStatus = mpu.dmpInitialize();

    // Установка начальных смещений гироскопа/акселерометра
    mpu.setXGyroOffset(0);
    mpu.setYGyroOffset(0);
    mpu.setZGyroOffset(0);
    mpu.setZAccelOffset(1688); // Заводская калибровка или авто-расчет

    if (devStatus == 0) {
        Serial.println("[SensorMPU] Автоматическая калибровка гироскопа и акселерометра...");
        mpu.CalibrateAccel(6);
        mpu.CalibrateGyro(6);
        mpu.PrintActiveOffsets();

        // Включение DMP
        Serial.println("[SensorMPU] Включение DMP...");
        mpu.setDMPEnabled(true);

        // Настройка аппаратного прерывания на пине ESP32
        pinMode(PIN_MPU_INT, INPUT);
        attachInterrupt(digitalPinToInterrupt(PIN_MPU_INT), dmpDataReadyISR, RISING);

        mpuIntStatus = mpu.getIntStatus();
        packetSize = mpu.dmpGetFIFOPacketSize();
        dmpReady = true;

        // Переключаем I2C на максимальную скорость 400 кГц для молниеносной работы в основном цикле
        Wire.setClock(400000);
        // Сбрасываем буфер FIFO, чтобы исключить ложное сообщение о переполнении после старта Wi-Fi
        mpu.resetFIFO();

        Serial.println("[SensorMPU] DMP успешно инициализирован! Готовность к работе (400 кГц).");
        return true;
    } else {
        Serial.printf("[SensorMPU] Ошибка инициализации DMP (код %d)\n", devStatus);
        return false;
    }
}

void SensorMPU::update() {
    if (!dmpReady) return;

    // Считываем текущее количество байт в буфере FIFO
    uint16_t fifoCount = mpu.getFIFOCount();

    // Если нет даже одного полного пакета (42 байта) — выходим
    if (fifoCount < packetSize) {
        return;
    }

    // Сбрасываем флаг аппаратного прерывания (если было)
    mpuInterrupt = false;
    uint8_t mpuIntStatus = mpu.getIntStatus();
    fifoCount = mpu.getFIFOCount();

    // Проверка переполнения FIFO буфера (1024 байта)
    if ((mpuIntStatus & (0x01 << MPU6050_INTERRUPT_FIFO_OFLOW_BIT)) || fifoCount >= 1024) {
        mpu.resetFIFO();
        Serial.println("[SensorMPU] Предупреждение: Переполнение FIFO, буфер сброшен!");
        return;
    }

    // Если в буфере есть хотя бы один полный пакет (42 байта) ИЛИ установлен бит готовности DMP
    if ((mpuIntStatus & (0x01 << MPU6050_INTERRUPT_DMP_INT_BIT)) || fifoCount >= packetSize) {
        // Вычитываем все полные пакеты до последнего, чтобы визуализация всегда показывала САМЫЙ СВЕЖИЙ угол без задержки!
        while (fifoCount >= packetSize) {
            mpu.getFIFOBytes(fifoBuffer, packetSize);
            fifoCount = mpu.getFIFOCount();
        }

        // Вычисляем кватернионы и углы Эйлера (в радианах, затем переводим в градусы)
        mpu.dmpGetQuaternion(&q, fifoBuffer);
        mpu.dmpGetGravity(&gravity, &q);
        mpu.dmpGetYawPitchRoll(ypr, &q, &gravity);

        // Читаем сырые значения гироскопа и акселерометра
        int16_t gx, gy, gz, ax, ay, az;
        mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

        // Расчет итоговых углов с учетом смещения рекалибровки
        float rawYaw = ypr[0] * 180.0f / M_PI;
        float rawPitch = ypr[1] * 180.0f / M_PI;
        float rawRoll = ypr[2] * 180.0f / M_PI;

        currentData.yaw = rawYaw - yawOffset;
        currentData.pitch = rawPitch - pitchOffset;
        currentData.roll = rawRoll - rollOffset;

        // Перевод гироскопа в град/сек (чувствительность MPU6050 ±250 deg/s по умолчанию -> 131 LSB/deg/s)
        currentData.gyroX = gx / 131.0f;
        currentData.gyroY = gy / 131.0f;
        currentData.gyroZ = gz / 131.0f;

        // Перевод ускорения в единицы g (±2g -> 16384 LSB/g)
        currentData.accelX = ax / 16384.0f;
        currentData.accelY = ay / 16384.0f;
        currentData.accelZ = az / 16384.0f;

        currentData.dataUpdated = true;
        currentData.timestamp = millis();
    }
}

bool SensorMPU::recalibrate() {
    if (!dmpReady) return false;

    Serial.println("[SensorMPU] Выполнение ручной рекалибровки на лету...");
    
    // Блокируем чтение FIFO на время перерасчета смещения
    mpuInterrupt = false;
    mpu.resetFIFO();

    // Ждем накопления стабильного пакета
    delay(50);
    uint16_t count = mpu.getFIFOCount();
    while (count < packetSize) {
        delay(10);
        count = mpu.getFIFOCount();
    }

    uint8_t buffer[64];
    mpu.getFIFOBytes(buffer, packetSize);
    
    Quaternion tempQ;
    VectorFloat tempGravity;
    float tempYPR[3];
    mpu.dmpGetQuaternion(&tempQ, buffer);
    mpu.dmpGetGravity(&tempGravity, &tempQ);
    mpu.dmpGetYawPitchRoll(tempYPR, &tempQ, &tempGravity);

    // Устанавливаем текущие углы в качестве нулевых смещений
    yawOffset = tempYPR[0] * 180.0f / M_PI;
    pitchOffset = tempYPR[1] * 180.0f / M_PI;
    rollOffset = tempYPR[2] * 180.0f / M_PI;

    mpu.resetFIFO();
    Serial.printf("[SensorMPU] Рекалибровка завершена! Новые смещения: Y=%.2f, P=%.2f, R=%.2f\n", yawOffset, pitchOffset, rollOffset);
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
