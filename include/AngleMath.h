#ifndef ANGLE_MATH_H
#define ANGLE_MATH_H

struct TiltPair {
    float roll;
    float pitch;
};

constexpr float normalizeAngleDifference(float difference) {
    return difference > 180.0f ? difference - 360.0f
        : difference < -180.0f ? difference + 360.0f : difference;
}

constexpr TiltPair mapAxisOrientation(float rawRoll, float rawPitch, bool invertX, bool invertY, bool swapAxes) {
    return TiltPair{
        invertX ? -(swapAxes ? rawPitch : rawRoll) : (swapAxes ? rawPitch : rawRoll),
        invertY ? -(swapAxes ? rawRoll : rawPitch) : (swapAxes ? rawRoll : rawPitch)
    };
}

constexpr TiltPair applyTiltTare(TiltPair mapped, float tareRoll, float tarePitch) {
    return TiltPair{
        normalizeAngleDifference(mapped.roll - tareRoll),
        normalizeAngleDifference(mapped.pitch - tarePitch)
    };
}

constexpr float absConstexpr(float value) {
    return value < 0.0f ? -value : value;
}

constexpr float clampPercentConstexpr(float value) {
    return value < 0.0f ? 0.0f : (value > 100.0f ? 100.0f : value);
}

constexpr float computeQuadrantSymmetryPct(float qFL, float qFR, float qBL, float qBR) {
    return (qFL + qFR + qBL + qBR) <= 0.001f
        ? 0.0f
        : clampPercentConstexpr(
            100.0f * (1.0f - (
                absConstexpr(qFL - 25.0f) +
                absConstexpr(qFR - 25.0f) +
                absConstexpr(qBL - 25.0f) +
                absConstexpr(qBR - 25.0f)
            ) / 150.0f)
        );
}

#endif
