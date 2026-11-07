#include "AngleMath.h"

static_assert(normalizeAngleDifference(-179.0f - 179.0f) == 2.0f, "Forward raw wrap");
static_assert(normalizeAngleDifference(179.0f - -179.0f) == -2.0f, "Reverse raw wrap");
static_assert(normalizeAngleDifference(180.0f - -180.0f) == 0.0f, "Equivalent endpoints");
static_assert(normalizeAngleDifference(-180.0f - 180.0f) == 0.0f, "Reverse endpoints");
static_assert(normalizeAngleDifference(180.0f) == 180.0f, "Positive half turn");
static_assert(normalizeAngleDifference(-180.0f) == -180.0f, "Negative half turn");
static_assert(normalizeAngleDifference(45.0f - 15.0f) == 30.0f, "Ordinary motion");

constexpr float calibratedBefore = normalizeAngleDifference(179.0f - 179.0f);
constexpr float calibratedAfter = normalizeAngleDifference(-179.0f - 179.0f);
static_assert(calibratedAfter - calibratedBefore == 2.0f, "Calibrated amplitude is two degrees");

constexpr float continuousForward = 179.0f + normalizeAngleDifference(-179.0f - 179.0f);
constexpr float continuousReverse = -179.0f + normalizeAngleDifference(179.0f - -179.0f);
static_assert(continuousForward == 181.0f, "Continuous positive joint angle");
static_assert(continuousReverse == -181.0f, "Continuous negative joint angle");
static_assert(continuousForward - 179.0f == 2.0f, "No false positive-wrap span");
static_assert(-179.0f - continuousReverse == 2.0f, "No false negative-wrap span");
static_assert(continuousForward + normalizeAngleDifference(179.0f - -179.0f) == 179.0f,
              "Return across wrap does not accumulate drift");

// 4-Way orientation mapping & tare parity checks (matching GameEngine._mapOrientation)
constexpr TiltPair mappedSwapInvertPitch = mapAxisOrientation(12.0f, -8.0f, false, true, true);
static_assert(mappedSwapInvertPitch.roll == -8.0f && mappedSwapInvertPitch.pitch == -12.0f,
              "90-degree swap and pitch inversion matches browser mapping");

constexpr TiltPair taredOrigin = applyTiltTare(mappedSwapInvertPitch, -8.0f, -12.0f);
static_assert(taredOrigin.roll == 0.0f && taredOrigin.pitch == 0.0f,
              "Tare preserves exact zero origin after orientation transform");

constexpr TiltPair movedPitch = applyTiltTare(
    mapAxisOrientation(12.0f, 7.0f, false, true, true), -8.0f, -12.0f
);
static_assert(movedPitch.roll == 15.0f && movedPitch.pitch == 0.0f,
              "+15 deg raw pitch delta maps cleanly to +15 deg horizontal when swapped");

constexpr TiltPair wrapAcrossTare = applyTiltTare(TiltPair{-175.0f, 178.0f}, 175.0f, -178.0f);
static_assert(wrapAcrossTare.roll == 10.0f && wrapAcrossTare.pitch == -4.0f,
              "Shortest-path tare across +/-180 seam");

// 4-Quadrant symmetry score bounds
static_assert(computeQuadrantSymmetryPct(25.0f, 25.0f, 25.0f, 25.0f) == 100.0f,
              "Uniform 4-quadrant distribution yields 100% symmetry");
static_assert(computeQuadrantSymmetryPct(100.0f, 0.0f, 0.0f, 0.0f) == 0.0f,
              "Single-quadrant lock yields 0% symmetry");
static_assert(computeQuadrantSymmetryPct(0.0f, 0.0f, 0.0f, 0.0f) == 0.0f,
              "Zero outside-deadzone time safely returns 0%");
static_assert(computeQuadrantSymmetryPct(50.0f, 50.0f, 0.0f, 0.0f) > 33.0f &&
              computeQuadrantSymmetryPct(50.0f, 50.0f, 0.0f, 0.0f) < 34.0f,
              "Two-quadrant 50/50 split yields ~33.3% 4-way symmetry");
