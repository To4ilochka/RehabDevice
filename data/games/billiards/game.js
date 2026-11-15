// ============================================================================
// 🎱 Більярд (Баланс-кий) — Реабілітаційний більярд для баланс-борду
// RehabDevice IoT | MPU6050 4-Way (Roll = приціл, Pitch = замах і удар) & 2-Way
// ============================================================================

window.RehabGames = window.RehabGames || {};

const TABLE_W = 1000;
const TABLE_H = 500;
const BALL_R = 16;
const CORNER_POCKET_R = 32;
const SIDE_POCKET_R = 30;
const ROLL_DECEL = 155;
const ROLL_DRAG = 0.72;
const MIN_STOP_SPEED = 7;
const MIN_SHOT_SPEED = 240;
const MAX_SHOT_SPEED = 1400;

const BALL_PALETTE = [
    { num: 1, color: "#fdd835", dark: "#f57f17", stripe: false },
    { num: 2, color: "#1e88e5", dark: "#0d47a1", stripe: false },
    { num: 3, color: "#e53935", dark: "#b71c1c", stripe: false },
    { num: 4, color: "#8e24aa", dark: "#4a148c", stripe: false },
    { num: 5, color: "#fb8c00", dark: "#e65100", stripe: false },
    { num: 6, color: "#43a047", dark: "#1b5e20", stripe: false },
    { num: 7, color: "#8d2b2b", dark: "#4e1414", stripe: false },
    { num: 8, color: "#263238", dark: "#0a0f12", stripe: false },
    { num: 9, color: "#fdd835", dark: "#f57f17", stripe: true },
    { num: 10, color: "#1e88e5", dark: "#0d47a1", stripe: true },
    { num: 11, color: "#e53935", dark: "#b71c1c", stripe: true },
    { num: 12, color: "#8e24aa", dark: "#4a148c", stripe: true },
    { num: 13, color: "#fb8c00", dark: "#e65100", stripe: true },
    { num: 14, color: "#43a047", dark: "#1b5e20", stripe: true },
    { num: 15, color: "#8d2b2b", dark: "#4e1414", stripe: true }
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeRadians = (rad) => {
    let a = rad % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
};

class BilliardsGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = 1;
        this.height = 1;
        this.active = false;

        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = "auto";
        this.inputMode = "four-direction";
        this.gameMode = "solo"; // "solo" | "bot"

        this.balls = [];
        this.pocketAnims = [];
        this.particles = [];
        this.pockets = this._buildPockets();

        this.cueAngle = 0;
        this.aimLocked = false;
        this.phase = "aim"; // "aim" | "charge" | "strike" | "rolling" | "bot_aim" | "rack_clear"
        this.currentTurn = "player"; // "player" | "bot"

        this.chargePower = 0;
        this.peakPull = 0;
        this.neutralTimer = 0;
        this.dwellTimer = 0;
        this.powerPhase = 0;
        this.strikeReadyDelay = 0;
        this.strikeTimer = 0;
        this.strikeDuration = 0.11;
        this.strikeStartPull = 0;

        this.botTimer = 0;
        this.botAimStart = 0;
        this.botTargetAngle = 0;
        this.botTargetPower = 0.65;
        this.botStreak = 0;
        this.rackClearTimer = 0;

        this.score = 0;
        this.botScore = 0;
        this.level = 1;
        this.combo = 1;
        this.shotsTaken = 0;
        this.ballsPocketedTotal = 0;
        this.pocketedThisTurn = [];
        this.scratchedThisTurn = false;

        this.bannerText = "";
        this.bannerTimer = 0;
        this.lastAxes = { x: 0, y: 0 };
        this.elapsedTime = 0;

        this.view = {
            isPortrait: false,
            scale: 1,
            feltLeft: 0,
            feltTop: 0,
            feltW: 1,
            feltH: 1
        };

        this._lastScoreHud = "";
        this._lastStateHud = "";
        this._uiContainer = null;
        this._uiClickHandler = null;
    }

    _buildPockets() {
        return [
            { x: 6, y: 6, r: CORNER_POCKET_R, corner: true },
            { x: TABLE_W / 2, y: -4, r: SIDE_POCKET_R, corner: false },
            { x: TABLE_W - 6, y: 6, r: CORNER_POCKET_R, corner: true },
            { x: 6, y: TABLE_H - 6, r: CORNER_POCKET_R, corner: true },
            { x: TABLE_W / 2, y: TABLE_H + 4, r: SIDE_POCKET_R, corner: false },
            { x: TABLE_W - 6, y: TABLE_H - 6, r: CORNER_POCKET_R, corner: true }
        ];
    }

    init(canvas, options) {
        const opts = options || {};
        this.ctx = canvas.getContext("2d");
        const bounds = canvas.getBoundingClientRect();
        this.resize(
            bounds.width || canvas.clientWidth || canvas.width || 1,
            bounds.height || canvas.clientHeight || canvas.height || 1
        );

        const min = Number(opts.calibMin);
        const max = Number(opts.calibMax);
        this.calibMin = Number.isFinite(min) ? min : -20;
        this.calibMax = Number.isFinite(max) ? max : 20;
        if (this.calibMax <= this.calibMin) {
            this.calibMin = -20;
            this.calibMax = 20;
        }

        this.difficulty = opts.difficulty || "auto";
        this.inputMode = opts.inputMode || "four-direction";
        this.gameMode = "solo";
        this.active = true;

        this.score = 0;
        this.botScore = 0;
        this.level = 1;
        this.combo = 1;
        this.shotsTaken = 0;
        this.ballsPocketedTotal = 0;
        this.elapsedTime = 0;
        this.lastAxes = { x: 0, y: 0 };
        this.particles = [];
        this.pocketAnims = [];
        this._lastScoreHud = "";
        this._lastStateHud = "";

        this._setupRack(this.level);
        this._renderCustomUI();
        this._updateHUD();
    }

    resize(width, height) {
        const w = Number(width);
        const h = Number(height);
        this.width = Number.isFinite(w) && w > 0 ? Math.max(1, Math.round(w)) : 1;
        this.height = Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h)) : 1;
        this._computeLayout();
    }

    _computeLayout() {
        const W = this.width;
        const H = this.height;
        const isPortrait = H > W * 1.05;
        const sidePad = Math.max(24, Math.min(72, W * 0.08));
        let minTop = isPortrait ? 112 : 78;
        if (typeof document !== "undefined") {
            const hud = document.getElementById("gameHUD");
            const canvasEl = this.ctx && this.ctx.canvas;
            if (hud && canvasEl) {
                const hudRect = hud.getBoundingClientRect();
                const canvasRect = canvasEl.getBoundingClientRect();
                if (hudRect.height > 0 && canvasRect.height > 0) {
                    minTop = Math.max(minTop, Math.ceil(hudRect.bottom - canvasRect.top) + 22);
                }
            }
        }
        const topPad = Math.max(minTop, Math.min(148, H * (isPortrait ? 0.175 : 0.14)));
        const bottomPad = Math.max(isPortrait ? 118 : 98, Math.min(145, H * (isPortrait ? 0.185 : 0.16)));

        const availW = Math.max(60, W - sidePad * 2);
        const availH = Math.max(60, H - topPad - bottomPad);
        const aspect = isPortrait ? TABLE_H / TABLE_W : TABLE_W / TABLE_H;

        let feltW;
        let feltH;
        if (availW / availH > aspect) {
            feltH = availH;
            feltW = feltH * aspect;
        } else {
            feltW = availW;
            feltH = feltW / aspect;
        }

        const feltLeft = (W - feltW) / 2;
        const feltTop = topPad + (availH - feltH) / 2;
        const scale = isPortrait ? feltW / TABLE_H : feltW / TABLE_W;

        this.view = {
            isPortrait,
            scale: Math.max(0.05, scale),
            feltLeft,
            feltTop,
            feltW,
            feltH
        };
    }

    _toScreen(tx, ty) {
        const v = this.view;
        if (v.isPortrait) {
            return {
                x: v.feltLeft + ty * v.scale,
                y: v.feltTop + (TABLE_W - tx) * v.scale
            };
        }
        return {
            x: v.feltLeft + tx * v.scale,
            y: v.feltTop + ty * v.scale
        };
    }

    _angleToScreen(rad) {
        return this.view.isPortrait ? rad - Math.PI / 2 : rad;
    }

    _setupRack(level) {
        this.balls = [];
        this.pocketAnims = [];
        this.pocketedThisTurn = [];
        this.scratchedThisTurn = false;
        this.currentTurn = "player";
        this.phase = "aim";
        this.aimLocked = false;
        this.chargePower = 0;
        this.peakPull = 0;
        this.neutralTimer = 0;
        this.dwellTimer = 0;
        this.powerPhase = 0;
        this.strikeTimer = 0;
        this.bannerText = level === 1 ? "Рівень 1 — Розігрів!" : `Рівень ${level} — Новий стіл!`;
        this.bannerTimer = 1.8;

        this.balls.push({
            id: 0,
            isCue: true,
            x: TABLE_W * 0.25,
            y: TABLE_H * 0.5,
            vx: 0,
            vy: 0,
            color: "#fafafa",
            dark: "#cbd5e1",
            stripe: false,
            pocketed: false
        });

        const rows = level === 1 ? 2 : level === 2 ? 3 : level === 3 ? 4 : 5;
        const apexX = TABLE_W * 0.7;
        const apexY = TABLE_H * 0.5;
        const dx = BALL_R * Math.sqrt(3) + 1.2;
        const dy = BALL_R * 2 + 1.2;

        let idx = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c <= r; c++) {
                const pal = BALL_PALETTE[idx % BALL_PALETTE.length];
                const bx = apexX + r * dx;
                const by = apexY + (c - r / 2) * dy;
                this.balls.push({
                    id: idx + 1,
                    num: pal.num,
                    isCue: false,
                    x: bx,
                    y: by,
                    vx: 0,
                    vy: 0,
                    color: pal.color,
                    dark: pal.dark,
                    stripe: pal.stripe,
                    pocketed: false
                });
                idx++;
            }
        }

        this.cueAngle = 0;
    }

    _getCueBall() {
        return this.balls.find(b => b.isCue);
    }

    _renderCustomUI() {
        if (!this.api || typeof this.api.setCustomHTML !== "function") return;
        const soloActive = this.gameMode === "solo";
        this.api.setCustomHTML(`
            <div id="billiardsControlsBar" style="position:absolute; left:50%; bottom:8px; transform:translateX(-50%); display:flex; gap:4px; align-items:center; pointer-events:auto; background:rgba(15,23,42,0.88); border:1px solid rgba(255,255,255,0.16); padding:4px 6px; border-radius:999px; backdrop-filter:blur(6px); max-width:calc(100% - 16px); white-space:nowrap;">
                <button type="button" data-billiards-action="mode-solo" style="border:none; border-radius:999px; padding:5px 9px; font-size:11px; font-weight:700; cursor:pointer; background:${soloActive ? "#00f2fe" : "rgba(255,255,255,0.08)"}; color:${soloActive ? "#07131d" : "#e2e8f0"};">👤 Соло</button>
                <button type="button" data-billiards-action="mode-bot" style="border:none; border-radius:999px; padding:5px 9px; font-size:11px; font-weight:700; cursor:pointer; background:${!soloActive ? "#ff9100" : "rgba(255,255,255,0.08)"}; color:${!soloActive ? "#07131d" : "#e2e8f0"};">🤖 VS Бот</button>
                <button type="button" data-billiards-action="reset-rack" style="border:1px solid rgba(255,255,255,0.2); border-radius:999px; padding:5px 9px; font-size:11px; font-weight:600; cursor:pointer; background:rgba(255,255,255,0.06); color:#f8fafc;">🔄 Заново</button>
            </div>
        `);

        const container = document.getElementById("custom-game-ui");
        if (container) {
            if (this._uiContainer && this._uiClickHandler) {
                this._uiContainer.removeEventListener("click", this._uiClickHandler);
            }
            this._uiContainer = container;
            this._uiClickHandler = (event) => {
                const btn = event.target?.closest?.("[data-billiards-action]");
                if (!btn || !this.active) return;
                const action = btn.getAttribute("data-billiards-action");
                if (action === "mode-solo") {
                    this.setGameMode("solo");
                } else if (action === "mode-bot") {
                    this.setGameMode("bot");
                } else if (action === "reset-rack") {
                    this.score = 0;
                    this.botScore = 0;
                    this.level = 1;
                    this.combo = 1;
                    this._setupRack(1);
                    this._updateHUD();
                }
            };
            container.addEventListener("click", this._uiClickHandler);
        }
    }

    setGameMode(mode) {
        this.gameMode = mode === "bot" ? "bot" : "solo";
        if (this.gameMode === "solo" && this.currentTurn === "bot") {
            this.currentTurn = "player";
            if (this.phase === "bot_aim") {
                this.phase = "aim";
                this.aimLocked = false;
                this.chargePower = 0;
            }
        }
        this._renderCustomUI();
        this._updateHUD();
    }

    _readInput(currentAngle, input) {
        let x = 0;
        let y = 0;
        const safeAngle = Number(currentAngle);
        const hasFiniteAngle = Number.isFinite(safeAngle);

        if (input && typeof input.getAxis === "function") {
            x = input.getAxis("Horizontal");
            y = input.getAxis("Vertical");
            if (x === 0 && hasFiniteAngle && safeAngle !== input.roll && typeof input.normalize === "function") {
                x = input.normalize(safeAngle, input.rollTare);
            }
        } else if (input && (Number.isFinite(Number(input.x)) || Number.isFinite(Number(input.y)))) {
            x = Number.isFinite(Number(input.x)) ? Number(input.x) : 0;
            y = Number.isFinite(Number(input.y)) ? Number(input.y) : 0;
        } else if (input && (Number.isFinite(Number(input.horizontal)) || Number.isFinite(Number(input.vertical)))) {
            x = Number.isFinite(Number(input.horizontal)) ? Number(input.horizontal) : 0;
            y = Number.isFinite(Number(input.vertical)) ? Number(input.vertical) : 0;
        } else if (hasFiniteAngle) {
            const range = this.calibMax - this.calibMin;
            const norm = Number.isFinite(range) && range > 0 ? (safeAngle - this.calibMin) / range : 0.5;
            x = (clamp(norm, 0, 1) - 0.5) * 2;
        }

        const safeX = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
        const safeY = this.inputMode === "two-direction"
            ? 0
            : (Number.isFinite(y) ? clamp(y, -1, 1) : 0);

        return { x: safeX, y: safeY };
    }

    _mapPullPower(vert) {
        return clamp((-vert - 0.20) / 0.62, 0, 1);
    }

    update(angle, dt) {
        if (!this.active) return;
        const input = arguments[2];
        if (input?.mode && input.mode !== this.inputMode) {
            this.inputMode = input.mode;
            this.neutralTimer = 0;
            this.dwellTimer = 0;
        }

        const safeDt = Number(dt);
        const step = Number.isFinite(safeDt) && safeDt >= 0 ? Math.min(0.1, safeDt) : 0;
        const safeAngle = Number(angle);

        if (Number.isFinite(safeAngle)) {
            let boundsChanged = false;
            if (safeAngle > this.calibMax) {
                this.calibMax += (safeAngle - this.calibMax) * 0.05;
                boundsChanged = true;
            }
            if (safeAngle < this.calibMin) {
                this.calibMin -= (this.calibMin - safeAngle) * 0.05;
                boundsChanged = true;
            }
            if (boundsChanged && this.api && typeof this.api.updateCalibration === "function") {
                this.api.updateCalibration(this.calibMin, this.calibMax);
            }
        }

        const axes = this._readInput(safeAngle, input);
        this.lastAxes = axes;

        if (step === 0) {
            this._updateHUD();
            return;
        }

        this.elapsedTime += step;
        if (this.bannerTimer > 0) this.bannerTimer = Math.max(0, this.bannerTimer - step);

        this._updateParticles(step);
        this._updatePocketAnims(step);

        if (this.phase === "rack_clear") {
            this.rackClearTimer -= step;
            if (this.rackClearTimer <= 0) {
                this._setupRack(this.level);
            }
            this._updateHUD();
            return;
        }

        if (this.phase === "aim" || this.phase === "charge") {
            this._updatePlayerControls(axes, step);
        } else if (this.phase === "strike") {
            this._updateStrike(step);
        } else if (this.phase === "bot_aim") {
            this._updateBotTurn(step);
        } else if (this.phase === "rolling") {
            this._stepPhysics(step);
        }

        this._updateHUD();
    }

    _updatePlayerControls(axes, dt) {
        if (this.phase === "aim") {
            if (this.inputMode === "two-direction") {
                if (axes.x !== 0) {
                    const absX = Math.abs(axes.x);
                    const turnSpeed = Math.sign(axes.x) * (0.45 * absX + 2.1 * Math.pow(absX, 2.2));
                    this.cueAngle = normalizeRadians(this.cueAngle + turnSpeed * dt);
                }
                if (Math.abs(axes.x) <= 0.08) {
                    this.dwellTimer += dt;
                    if (this.dwellTimer >= 1.1) {
                        this.phase = "charge";
                        this.aimLocked = true;
                        this.powerPhase = 0;
                        this.chargePower = 0.18;
                        this.strikeReadyDelay = 0.25;
                    }
                } else {
                    this.dwellTimer = 0;
                }
            } else {
                this.dwellTimer = 0;
                if (axes.y <= -0.22) {
                    // Enter charge immediately so lateral ankle shift during pull-back does not jerk aim
                    this.phase = "charge";
                    this.aimLocked = true;
                    this.peakPull = this._mapPullPower(axes.y);
                    this.chargePower = 0.18 + 0.82 * this.peakPull;
                    this.neutralTimer = 0;
                } else if (axes.x !== 0) {
                    const absX = Math.abs(axes.x);
                    const turnSpeed = Math.sign(axes.x) * (0.45 * absX + 2.1 * Math.pow(absX, 2.2));
                    this.cueAngle = normalizeRadians(this.cueAngle + turnSpeed * dt);
                }
            }
            return;
        }

        if (this.phase === "charge") {
            if (this.inputMode === "two-direction") {
                this.strikeReadyDelay = Math.max(0, this.strikeReadyDelay - dt);
                this.powerPhase += dt * 1.45;
                const tri = 1 - Math.abs((this.powerPhase % 2) - 1);
                this.chargePower = 0.18 + 0.82 * tri;
                if (this.strikeReadyDelay <= 0 && Math.abs(axes.x) >= 0.35) {
                    this._startStrike();
                }
            } else {
                if (axes.y < -0.15) {
                    const rawPull = this._mapPullPower(axes.y);
                    this.peakPull = Math.max(this.peakPull, rawPull);
                    this.chargePower = 0.18 + 0.82 * this.peakPull;
                    this.neutralTimer = 0;
                } else if (axes.y >= 0.22) {
                    this._startStrike();
                } else {
                    this.neutralTimer += dt;
                    if (this.neutralTimer >= 1.35) {
                        this.phase = "aim";
                        this.aimLocked = false;
                        this.chargePower = 0;
                        this.peakPull = 0;
                        this.neutralTimer = 0;
                    }
                }
            }
        }
    }

    _startStrike() {
        this.phase = "strike";
        this.strikeTimer = 0;
        this.strikeStartPull = clamp(this.chargePower, 0.18, 1);
    }

    _updateStrike(dt) {
        this.strikeTimer += dt;
        if (this.strikeTimer >= this.strikeDuration) {
            const cue = this._getCueBall();
            if (cue && !cue.pocketed) {
                const shotSpeed = MIN_SHOT_SPEED + this.strikeStartPull * (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
                cue.vx = Math.cos(this.cueAngle) * shotSpeed;
                cue.vy = Math.sin(this.cueAngle) * shotSpeed;
                this._spawnImpactParticles(
                    cue.x - Math.cos(this.cueAngle) * BALL_R,
                    cue.y - Math.sin(this.cueAngle) * BALL_R,
                    "#00f2fe",
                    10
                );
            }
            this.shotsTaken++;
            this.pocketedThisTurn = [];
            this.scratchedThisTurn = false;
            this.aimLocked = false;
            this.chargePower = 0;
            this.peakPull = 0;
            this.neutralTimer = 0;
            this.dwellTimer = 0;
            this.phase = "rolling";
        }
    }

    _planBotShot() {
        const cue = this._getCueBall();
        const targets = this.balls.filter(b => !b.isCue && !b.pocketed);
        if (!cue || targets.length === 0) {
            this.botTargetAngle = 0;
            this.botTargetPower = 0.5;
            return;
        }

        let bestScore = -Infinity;
        let bestAngle = 0;
        let bestPower = 0.65;

        for (const ball of targets) {
            for (const pocket of this.pockets) {
                const px = pocket.x - ball.x;
                const py = pocket.y - ball.y;
                const pDist = Math.hypot(px, py);
                if (pDist < 1) continue;
                const pnx = px / pDist;
                const pny = py / pDist;

                const ghostX = ball.x - pnx * (BALL_R * 2);
                const ghostY = ball.y - pny * (BALL_R * 2);
                const cx = ghostX - cue.x;
                const cy = ghostY - cue.y;
                const cDist = Math.hypot(cx, cy);
                if (cDist < 1) continue;
                const cnx = cx / cDist;
                const cny = cy / cDist;

                const alignment = cnx * pnx + cny * pny;
                if (alignment <= 0.15) continue;

                const blockerPenalty = this._hasPathBlocker(cue, ball, ghostX, ghostY) ? 0.55 : 0;
                const shotValue = alignment * 2.2 - (cDist + pDist) / 1400 - blockerPenalty;

                if (shotValue > bestScore) {
                    bestScore = shotValue;
                    bestAngle = Math.atan2(cy, cx);
                    bestPower = clamp(0.38 + (cDist + pDist) / 1500, 0.38, 0.92);
                }
            }
        }

        if (bestScore === -Infinity) {
            const t = targets[0];
            bestAngle = Math.atan2(t.y - cue.y, t.x - cue.x);
            bestPower = 0.65;
        }

        const jitter = (Math.random() - 0.5) * 0.085;
        this.botTargetAngle = normalizeRadians(bestAngle + jitter);
        this.botTargetPower = bestPower;
        this.botAimStart = this.cueAngle;
        this.botTimer = 0;
    }

    _hasPathBlocker(cue, target, gx, gy) {
        const dx = gx - cue.x;
        const dy = gy - cue.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1) return false;
        for (const other of this.balls) {
            if (other.pocketed || other === cue || other === target) continue;
            const t = clamp(((other.x - cue.x) * dx + (other.y - cue.y) * dy) / lenSq, 0, 1);
            const px = cue.x + dx * t;
            const py = cue.y + dy * t;
            if (Math.hypot(other.x - px, other.y - py) < BALL_R * 1.95) return true;
        }
        return false;
    }

    _updateBotTurn(dt) {
        this.botTimer += dt;
        const aimDuration = 1.0;
        const chargeDuration = 0.55;

        if (this.botTimer < aimDuration) {
            const t = clamp(this.botTimer / aimDuration, 0, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            const diff = normalizeRadians(this.botTargetAngle - this.botAimStart);
            this.cueAngle = normalizeRadians(this.botAimStart + diff * ease);
            this.chargePower = 0;
        } else if (this.botTimer < aimDuration + chargeDuration) {
            const t = clamp((this.botTimer - aimDuration) / chargeDuration, 0, 1);
            this.cueAngle = this.botTargetAngle;
            this.chargePower = this.botTargetPower * t;
        } else {
            this.cueAngle = this.botTargetAngle;
            this.chargePower = this.botTargetPower;
            this._startStrike();
        }
    }

    _stepPhysics(dt) {
        let maxSpeed = 0;
        for (const b of this.balls) {
            if (b.pocketed) continue;
            const spd = Math.hypot(b.vx, b.vy);
            if (spd > maxSpeed) maxSpeed = spd;
        }

        const substeps = Math.max(4, Math.min(16, Math.ceil((maxSpeed * dt) / (BALL_R * 0.45))));
        const subDt = dt / substeps;
        const activeBalls = this.balls.filter(b => !b.pocketed);

        for (let s = 0; s < substeps; s++) {
            for (const b of activeBalls) {
                if (b.pocketed) continue;
                b.x += b.vx * subDt;
                b.y += b.vy * subDt;

                if (this._checkPocketCapture(b)) continue;
                this._collideWalls(b);
            }

            for (let i = 0; i < activeBalls.length; i++) {
                const b1 = activeBalls[i];
                if (b1.pocketed) continue;
                for (let j = i + 1; j < activeBalls.length; j++) {
                    const b2 = activeBalls[j];
                    if (b2.pocketed) continue;
                    this._resolveBallCollision(b1, b2);
                }
            }

            const dragFactor = Math.exp(-ROLL_DRAG * subDt);
            for (const b of activeBalls) {
                if (b.pocketed) continue;
                let spd = Math.hypot(b.vx, b.vy);
                if (spd <= 0) continue;
                spd = spd * dragFactor - ROLL_DECEL * subDt;
                if (spd <= MIN_STOP_SPEED) {
                    b.vx = 0;
                    b.vy = 0;
                } else {
                    const ratio = spd / Math.hypot(b.vx, b.vy);
                    b.vx *= ratio;
                    b.vy *= ratio;
                }
            }
        }

        const anyMoving = this.balls.some(b => !b.pocketed && (b.vx !== 0 || b.vy !== 0));
        if (!anyMoving && this.pocketAnims.length === 0) {
            this._finishTurn();
        }
    }

    _isInPocketMouth(x, y) {
        for (const p of this.pockets) {
            if (Math.hypot(x - p.x, y - p.y) < p.r * 1.12) return true;
        }
        return false;
    }

    _checkPocketCapture(ball) {
        for (const p of this.pockets) {
            const dist = Math.hypot(ball.x - p.x, ball.y - p.y);
            if (dist < p.r * 0.88) {
                ball.pocketed = true;
                ball.vx = 0;
                ball.vy = 0;
                this.pocketAnims.push({
                    x: ball.x,
                    y: ball.y,
                    tx: p.x,
                    ty: p.y,
                    color: ball.color,
                    stripe: ball.stripe,
                    num: ball.num,
                    isCue: ball.isCue,
                    progress: 0
                });
                this._spawnImpactParticles(p.x, p.y, ball.isCue ? "#ff5252" : "#ffd54f", 14);
                if (ball.isCue) {
                    this.scratchedThisTurn = true;
                } else {
                    this.pocketedThisTurn.push(ball);
                    this.ballsPocketedTotal++;
                }
                return true;
            }
        }
        return false;
    }

    _collideWalls(ball) {
        if (this._isInPocketMouth(ball.x, ball.y)) return;

        const restitution = 0.82;
        if (ball.x < BALL_R) {
            ball.x = BALL_R;
            ball.vx = Math.abs(ball.vx) * restitution;
            ball.vy *= 0.97;
        } else if (ball.x > TABLE_W - BALL_R) {
            ball.x = TABLE_W - BALL_R;
            ball.vx = -Math.abs(ball.vx) * restitution;
            ball.vy *= 0.97;
        }

        if (ball.y < BALL_R) {
            ball.y = BALL_R;
            ball.vy = Math.abs(ball.vy) * restitution;
            ball.vx *= 0.97;
        } else if (ball.y > TABLE_H - BALL_R) {
            ball.y = TABLE_H - BALL_R;
            ball.vy = -Math.abs(ball.vy) * restitution;
            ball.vx *= 0.97;
        }
    }

    _resolveBallCollision(b1, b2) {
        const dx = b2.x - b1.x;
        const dy = b2.y - b1.y;
        const dist = Math.hypot(dx, dy);
        const minDist = BALL_R * 2;
        if (dist >= minDist) return;

        let nx = 1;
        let ny = 0;
        if (dist > 1e-6) {
            nx = dx / dist;
            ny = dy / dist;
        }

        const overlap = minDist - dist;
        b1.x -= nx * overlap * 0.5;
        b1.y -= ny * overlap * 0.5;
        b2.x += nx * overlap * 0.5;
        b2.y += ny * overlap * 0.5;

        const rvx = b1.vx - b2.vx;
        const rvy = b1.vy - b2.vy;
        const velAlongNormal = rvx * nx + rvy * ny;
        if (velAlongNormal <= 0) return;

        const restitution = 0.94;
        const impulse = (1 + restitution) * velAlongNormal * 0.5;
        b1.vx -= impulse * nx;
        b1.vy -= impulse * ny;
        b2.vx += impulse * nx;
        b2.vy += impulse * ny;

        if (velAlongNormal > 280) {
            this._spawnImpactParticles(
                (b1.x + b2.x) * 0.5,
                (b1.y + b2.y) * 0.5,
                "#ffffff",
                5
            );
        }
    }

    _respawnCueBall() {
        const cue = this._getCueBall();
        if (!cue) return;
        const baseX = TABLE_W * 0.25;
        const baseY = TABLE_H * 0.5;
        let placedX = baseX;
        let placedY = baseY;

        const isFree = (x, y) => this.balls.every(b =>
            b === cue || b.pocketed || Math.hypot(b.x - x, b.y - y) >= BALL_R * 2.15
        );

        if (!isFree(placedX, placedY)) {
            outer:
            for (let radius = BALL_R * 2.2; radius <= 220; radius += BALL_R * 1.4) {
                for (let step = 0; step < 16; step++) {
                    const a = (step / 16) * Math.PI * 2;
                    const cx = clamp(baseX + Math.cos(a) * radius, BALL_R * 1.5, TABLE_W - BALL_R * 1.5);
                    const cy = clamp(baseY + Math.sin(a) * radius, BALL_R * 1.5, TABLE_H - BALL_R * 1.5);
                    if (isFree(cx, cy)) {
                        placedX = cx;
                        placedY = cy;
                        break outer;
                    }
                }
            }
        }

        cue.pocketed = false;
        cue.x = placedX;
        cue.y = placedY;
        cue.vx = 0;
        cue.vy = 0;
    }

    _finishTurn() {
        const pocketedCount = this.pocketedThisTurn.length;
        const fouled = this.scratchedThisTurn;

        if (fouled) {
            this._respawnCueBall();
            if (this.currentTurn === "player") {
                this.score = Math.max(0, this.score - 50);
                this.combo = 1;
                this.bannerText = "Біток у лузі! Штраф -50";
            } else {
                this.botScore = Math.max(0, this.botScore - 50);
                this.bannerText = "Бот забив біток! Ваш хід";
            }
            this.bannerTimer = 1.6;
        } else if (pocketedCount > 0) {
            if (this.currentTurn === "player") {
                const earned = pocketedCount * 100 * this.combo;
                this.score += earned;
                this.combo = Math.min(8, this.combo + pocketedCount);
                this.bannerText = this.combo > 2
                    ? `Влучно! +${earned} (Комбо x${this.combo - 1})`
                    : `Влучно! +${earned}`;
            } else {
                const earned = pocketedCount * 100;
                this.botScore += earned;
                this.bannerText = `Бот забив кулю! (+${earned})`;
            }
            this.bannerTimer = 1.4;
        } else {
            if (this.currentTurn === "player") this.combo = 1;
        }

        const remaining = this.balls.filter(b => !b.isCue && !b.pocketed).length;
        if (remaining === 0) {
            const bonus = 250 * this.level;
            if (this.currentTurn === "player" || this.gameMode === "solo") {
                this.score += bonus;
            } else {
                this.botScore += bonus;
            }
            this.level++;
            this.phase = "rack_clear";
            this.rackClearTimer = 1.8;
            this.bannerText = `Стіл очищено! Бонус +${bonus}`;
            this.bannerTimer = 1.8;
            return;
        }

        if (this.gameMode === "bot") {
            if (fouled || pocketedCount === 0) {
                this.currentTurn = this.currentTurn === "player" ? "bot" : "player";
                this.botStreak = 0;
            } else if (this.currentTurn === "bot") {
                this.botStreak++;
                if (this.botStreak >= 2) {
                    this.currentTurn = "player";
                    this.botStreak = 0;
                }
            }
        } else {
            this.currentTurn = "player";
            this.botStreak = 0;
        }

        if (this.currentTurn === "bot") {
            this.phase = "bot_aim";
            this._planBotShot();
        } else {
            this.phase = "aim";
            this.aimLocked = false;
            this.chargePower = 0;
            this.peakPull = 0;
            this.neutralTimer = 0;
            this.dwellTimer = 0;
        }
    }

    _spawnImpactParticles(tx, ty, color, count) {
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const spd = 40 + Math.random() * 140;
            this.particles.push({
                x: tx,
                y: ty,
                vx: Math.cos(a) * spd,
                vy: Math.sin(a) * spd,
                life: 1,
                maxLife: 0.35 + Math.random() * 0.3,
                size: 2.5 + Math.random() * 3,
                color
            });
        }
    }

    _updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= dt / p.maxLife;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    _updatePocketAnims(dt) {
        for (let i = this.pocketAnims.length - 1; i >= 0; i--) {
            const a = this.pocketAnims[i];
            a.progress += dt * 4.5;
            if (a.progress >= 1) this.pocketAnims.splice(i, 1);
        }
    }

    _computeAimRay() {
        const cue = this._getCueBall();
        if (!cue || cue.pocketed) return null;

        const dx = Math.cos(this.cueAngle);
        const dy = Math.sin(this.cueAngle);
        let minT = Infinity;
        let hitBall = null;

        if (dx > 1e-6) minT = Math.min(minT, (TABLE_W - BALL_R - cue.x) / dx);
        else if (dx < -1e-6) minT = Math.min(minT, (BALL_R - cue.x) / dx);

        if (dy > 1e-6) minT = Math.min(minT, (TABLE_H - BALL_R - cue.y) / dy);
        else if (dy < -1e-6) minT = Math.min(minT, (BALL_R - cue.y) / dy);

        const rSum = BALL_R * 2;
        for (const ball of this.balls) {
            if (ball.pocketed || ball.isCue) continue;
            const ocX = cue.x - ball.x;
            const ocY = cue.y - ball.y;
            const b = ocX * dx + ocY * dy;
            const c = ocX * ocX + ocY * ocY - rSum * rSum;
            const disc = b * b - c;
            if (disc < 0) continue;
            const t = -b - Math.sqrt(disc);
            if (t >= 0 && t < minT) {
                minT = t;
                hitBall = ball;
            }
        }

        if (!Number.isFinite(minT) || minT < 0) minT = 0;
        const gx = cue.x + dx * minT;
        const gy = cue.y + dy * minT;
        let targetDir = null;
        if (hitBall) {
            const tx = hitBall.x - gx;
            const ty = hitBall.y - gy;
            const tl = Math.hypot(tx, ty);
            if (tl > 1e-6) targetDir = { x: tx / tl, y: ty / tl };
        }

        return { gx, gy, hitBall, targetDir };
    }

    _updateHUD() {
        if (!this.api || typeof this.api.updateHUD !== "function") return;
        const remaining = this.balls.filter(b => !b.isCue && !b.pocketed).length;
        const scoreText = this.gameMode === "bot"
            ? `Ви: ${this.score} | Бот: ${this.botScore} | Куль: ${remaining}`
            : `Очки: ${this.score} | Рівень: ${this.level} | Куль: ${remaining}`;

        let stateText;
        if (this.phase === "rack_clear") {
            stateText = `Стіл очищено! Нова піраміда...`;
        } else if (this.phase === "bot_aim") {
            stateText = `Хід Бота: прицілювання...`;
        } else if (this.phase === "rolling" || this.phase === "strike") {
            stateText = this.currentTurn === "bot" ? "Хід Бота..." : "Удар! Кулі в русі";
        } else if (this.phase === "charge") {
            const pct = Math.round(this.chargePower * 100);
            stateText = this.inputMode === "two-direction"
                ? `Сила: ${pct}% | Нахиліть вбік для удару!`
                : `Замах: ${pct}% | Нахиліться вперед — УДАР!`;
        } else {
            stateText = this.inputMode === "two-direction"
                ? `Приціл: нахил ◀▶ | Утримуйте 0° для сили`
                : `Приціл: ◀▶ | Замах: назад ⬇`;
        }

        if (scoreText !== this._lastScoreHud) {
            this.api.updateHUD("hudScore", scoreText);
            this._lastScoreHud = scoreText;
        }
        if (stateText !== this._lastStateHud) {
            this.api.updateHUD("hudBotState", stateText);
            this._lastStateHud = stateText;
        }
    }

    draw(ctx) {
        if (!this.active) return;
        const renderCtx = ctx || this.ctx;
        if (!renderCtx) return;
        this.ctx = renderCtx;

        const W = this.width;
        const H = this.height;

        renderCtx.save();
        this._drawRoomBackground(renderCtx, W, H);
        this._drawTable(renderCtx);
        this._drawPocketAnims(renderCtx);
        this._drawBalls(renderCtx);
        this._drawParticles(renderCtx);

        if (this.phase === "aim" || this.phase === "charge" || this.phase === "strike" || this.phase === "bot_aim") {
            this._drawAimAndCue(renderCtx);
        }

        this._drawBottomControlsHint(renderCtx, W, H);
        if (this.bannerTimer > 0 && this.bannerText) {
            this._drawBanner(renderCtx, W, H);
        }
        renderCtx.restore();
    }

    _drawRoomBackground(ctx, W, H) {
        const bg = ctx.createRadialGradient(W / 2, H * 0.46, 20, W / 2, H * 0.5, Math.max(W, H) * 0.78);
        bg.addColorStop(0, "#1c2e45");
        bg.addColorStop(0.55, "#111c2d");
        bg.addColorStop(1, "#080d17");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
    }

    _drawTable(ctx) {
        const v = this.view;
        const rail = Math.max(12, 24 * v.scale);
        const outerX = v.feltLeft - rail;
        const outerY = v.feltTop - rail;
        const outerW = v.feltW + rail * 2;
        const outerH = v.feltH + rail * 2;

        ctx.save();
        ctx.shadowBlur = 28;
        ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
        const woodGrad = ctx.createLinearGradient(outerX, outerY, outerX + outerW, outerY + outerH);
        woodGrad.addColorStop(0, "#6d3b1e");
        woodGrad.addColorStop(0.5, "#4e2712");
        woodGrad.addColorStop(1, "#381a0b");
        ctx.fillStyle = woodGrad;
        this._roundRect(ctx, outerX, outerY, outerW, outerH, rail * 0.7);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = "#8a522d";
        ctx.lineWidth = Math.max(1.5, 2 * v.scale);
        ctx.stroke();

        // Brass corner plates
        const cornerSize = rail * 0.95;
        ctx.fillStyle = "#d4af37";
        const corners = [
            [outerX, outerY],
            [outerX + outerW - cornerSize, outerY],
            [outerX, outerY + outerH - cornerSize],
            [outerX + outerW - cornerSize, outerY + outerH - cornerSize]
        ];
        for (const [cx, cy] of corners) {
            this._roundRect(ctx, cx, cy, cornerSize, cornerSize, rail * 0.32);
            ctx.fill();
        }

        // Emerald cloth felt
        const feltGrad = ctx.createRadialGradient(
            v.feltLeft + v.feltW * 0.5,
            v.feltTop + v.feltH * 0.5,
            v.feltW * 0.08,
            v.feltLeft + v.feltW * 0.5,
            v.feltTop + v.feltH * 0.5,
            Math.max(v.feltW, v.feltH) * 0.75
        );
        feltGrad.addColorStop(0, "#158056");
        feltGrad.addColorStop(0.65, "#0e6442");
        feltGrad.addColorStop(1, "#09462d");
        ctx.fillStyle = feltGrad;
        ctx.fillRect(v.feltLeft, v.feltTop, v.feltW, v.feltH);

        // Inner cushion shadow border
        ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
        ctx.lineWidth = Math.max(2, 4 * v.scale);
        ctx.strokeRect(v.feltLeft, v.feltTop, v.feltW, v.feltH);

        // Baulk line and head spot
        const baulkA = this._toScreen(TABLE_W * 0.25, 0);
        const baulkB = this._toScreen(TABLE_W * 0.25, TABLE_H);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(baulkA.x, baulkA.y);
        ctx.lineTo(baulkB.x, baulkB.y);
        ctx.stroke();

        const headSpot = this._toScreen(TABLE_W * 0.25, TABLE_H * 0.5);
        ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
        ctx.beginPath();
        ctx.arc(headSpot.x, headSpot.y, Math.max(2, 4 * v.scale), 0, Math.PI * 2);
        ctx.fill();

        // Rail diamonds
        ctx.fillStyle = "rgba(255, 235, 180, 0.55)";
        for (const frac of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) {
            const topD = this._toScreen(TABLE_W * frac, -14);
            const botD = this._toScreen(TABLE_W * frac, TABLE_H + 14);
            for (const pt of [topD, botD]) {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, Math.max(1.5, 2.5 * v.scale), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        for (const frac of [0.25, 0.5, 0.75]) {
            const leftD = this._toScreen(-14, TABLE_H * frac);
            const rightD = this._toScreen(TABLE_W + 14, TABLE_H * frac);
            for (const pt of [leftD, rightD]) {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, Math.max(1.5, 2.5 * v.scale), 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Pockets
        for (const p of this.pockets) {
            const sp = this._toScreen(p.x, p.y);
            const pr = p.r * v.scale;
            ctx.fillStyle = "#2b160c";
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, pr * 1.15, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = "#05070a";
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, pr * 0.92, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _drawPocketAnims(ctx) {
        for (const a of this.pocketAnims) {
            const k = clamp(a.progress, 0, 1);
            const lx = a.x + (a.tx - a.x) * k;
            const ly = a.y + (a.ty - a.y) * k;
            const sp = this._toScreen(lx, ly);
            const r = BALL_R * this.view.scale * (1 - k * 0.65);
            if (r <= 0.5) continue;
            ctx.save();
            ctx.globalAlpha = 1 - k;
            ctx.fillStyle = a.color;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    _drawBalls(ctx) {
        const r = Math.max(4, BALL_R * this.view.scale);
        for (const b of this.balls) {
            if (b.pocketed) continue;
            const sp = this._toScreen(b.x, b.y);

            ctx.save();
            // Drop shadow
            ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
            ctx.beginPath();
            ctx.ellipse(sp.x + r * 0.18, sp.y + r * 0.24, r * 0.98, r * 0.85, 0, 0, Math.PI * 2);
            ctx.fill();

            if (b.stripe) {
                ctx.fillStyle = "#f8fafc";
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
                ctx.fill();

                ctx.save();
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
                ctx.clip();
                ctx.fillStyle = b.color;
                ctx.fillRect(sp.x - r, sp.y - r * 0.52, r * 2, r * 1.04);
                ctx.restore();
            } else {
                const grad = ctx.createRadialGradient(
                    sp.x - r * 0.32,
                    sp.y - r * 0.32,
                    r * 0.1,
                    sp.x,
                    sp.y,
                    r
                );
                grad.addColorStop(0, b.isCue ? "#ffffff" : b.color);
                grad.addColorStop(0.7, b.color);
                grad.addColorStop(1, b.dark);
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
                ctx.fill();
            }

            if (b.isCue) {
                ctx.fillStyle = "#ef4444";
                ctx.beginPath();
                ctx.arc(sp.x + r * 0.22, sp.y - r * 0.12, Math.max(1.2, r * 0.14), 0, Math.PI * 2);
                ctx.fill();
            } else if (r >= 7) {
                ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, r * 0.44, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = "#0f172a";
                ctx.font = `800 ${Math.max(7, Math.round(r * 0.62))}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(b.num), sp.x, sp.y + 0.5);
            }

            // Specular highlight
            ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
            ctx.beginPath();
            ctx.ellipse(sp.x - r * 0.3, sp.y - r * 0.32, r * 0.28, r * 0.16, -0.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    _drawAimAndCue(ctx) {
        const cue = this._getCueBall();
        if (!cue || cue.pocketed) return;
        const v = this.view;
        const r = Math.max(4, BALL_R * v.scale);
        const cuePt = this._toScreen(cue.x, cue.y);
        const screenAngle = this._angleToScreen(this.cueAngle);
        const isBot = this.phase === "bot_aim" || this.currentTurn === "bot";

        // Aim guide + ghost ball
        const ray = this._computeAimRay();
        if (ray) {
            const hitPt = this._toScreen(ray.gx, ray.gy);
            ctx.save();
            ctx.strokeStyle = isBot ? "rgba(255, 145, 0, 0.45)" : "rgba(0, 242, 254, 0.58)";
            ctx.lineWidth = Math.max(1.5, 2 * v.scale);
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.moveTo(cuePt.x, cuePt.y);
            ctx.lineTo(hitPt.x, hitPt.y);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.strokeStyle = isBot ? "rgba(255, 145, 0, 0.65)" : "rgba(255, 255, 255, 0.72)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(hitPt.x, hitPt.y, r, 0, Math.PI * 2);
            ctx.stroke();

            if (ray.targetDir) {
                const ballPt = this._toScreen(ray.hitBall.x, ray.hitBall.y);
                const endPt = this._toScreen(
                    ray.hitBall.x + ray.targetDir.x * 85,
                    ray.hitBall.y + ray.targetDir.y * 85
                );
                ctx.strokeStyle = "rgba(255, 214, 0, 0.85)";
                ctx.lineWidth = Math.max(2, 2.5 * v.scale);
                ctx.beginPath();
                ctx.moveTo(ballPt.x, ballPt.y);
                ctx.lineTo(endPt.x, endPt.y);
                ctx.stroke();
            }
            ctx.restore();
        }

        // Compute pullback distance
        let pullback = 0;
        if (this.phase === "charge" || this.phase === "bot_aim") {
            pullback = this.chargePower * 54 * v.scale;
        } else if (this.phase === "strike") {
            const p = clamp(this.strikeTimer / this.strikeDuration, 0, 1);
            pullback = (1 - p) * this.strikeStartPull * 54 * v.scale;
        }

        // Dwell lock ring in 2-way mode
        if (this.phase === "aim" && this.inputMode === "two-direction" && this.dwellTimer > 0.05) {
            const frac = clamp(this.dwellTimer / 1.1, 0, 1);
            ctx.save();
            ctx.strokeStyle = "#00e676";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cuePt.x, cuePt.y, r + 7, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Cue stick + Player/Bot character
        const tipOffset = r + 6 * v.scale + pullback;
        const cueLen = Math.max(115, 230 * v.scale);
        const dirX = Math.cos(screenAngle);
        const dirY = Math.sin(screenAngle);

        const tipX = cuePt.x - dirX * tipOffset;
        const tipY = cuePt.y - dirY * tipOffset;
        const buttX = cuePt.x - dirX * (tipOffset + cueLen);
        const buttY = cuePt.y - dirY * (tipOffset + cueLen);

        ctx.save();
        // Cue shadow
        ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
        ctx.lineWidth = Math.max(3.5, 6 * v.scale);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tipX + 3, tipY + 4);
        ctx.lineTo(buttX + 3, buttY + 4);
        ctx.stroke();

        // Cue shaft + butt gradient
        const cueGrad = ctx.createLinearGradient(tipX, tipY, buttX, buttY);
        cueGrad.addColorStop(0, "#f5e6c8");
        cueGrad.addColorStop(0.55, "#d8a96e");
        cueGrad.addColorStop(0.65, isBot ? "#7c2d12" : "#1e293b");
        cueGrad.addColorStop(1, isBot ? "#ea580c" : "#0284c7");
        ctx.strokeStyle = cueGrad;
        ctx.lineWidth = Math.max(3, 5.5 * v.scale);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(buttX, buttY);
        ctx.stroke();

        // Blue chalk cue tip
        ctx.fillStyle = "#00f2fe";
        ctx.beginPath();
        ctx.arc(tipX, tipY, Math.max(2, 3 * v.scale), 0, Math.PI * 2);
        ctx.fill();

        // Power gauge arc around cue ball while charging
        if (this.phase === "charge" || (this.phase === "bot_aim" && this.chargePower > 0.05)) {
            const p = clamp(this.chargePower, 0, 1);
            const meterColor = p < 0.45 ? "#00e676" : p < 0.78 ? "#ffd54f" : "#ff5252";
            ctx.strokeStyle = "rgba(255,255,255,0.2)";
            ctx.lineWidth = Math.max(3, 4 * v.scale);
            ctx.beginPath();
            ctx.arc(cuePt.x, cuePt.y, r + 10 * v.scale, screenAngle + Math.PI - 0.85, screenAngle + Math.PI + 0.85);
            ctx.stroke();

            ctx.strokeStyle = meterColor;
            ctx.beginPath();
            ctx.arc(
                cuePt.x,
                cuePt.y,
                r + 10 * v.scale,
                screenAngle + Math.PI - 0.85,
                screenAngle + Math.PI - 0.85 + 1.7 * p
            );
            ctx.stroke();
        }

        // Stylized top-down character holding the cue
        this._drawCueCharacter(ctx, cuePt, screenAngle, tipOffset, pullback, isBot);
        ctx.restore();
    }

    _drawCueCharacter(ctx, cuePt, screenAngle, tipOffset, pullback, isBot) {
        const sc = Math.max(0.55, Math.min(1.15, this.view.scale * 1.15));
        const charDist = Math.max(tipOffset + 96 * sc, tipOffset + 85);
        const dirX = Math.cos(screenAngle);
        const dirY = Math.sin(screenAngle);

        const rawX = cuePt.x - dirX * charDist;
        const rawY = cuePt.y - dirY * charDist;
        const margin = Math.min(24 * sc, this.width * 0.4, this.height * 0.4);
        const cx = clamp(rawX, margin, Math.max(margin, this.width - margin));
        const minY = Math.min(68, this.height * 0.5);
        const maxY = Math.max(minY, this.height - 62);
        const cy = clamp(rawY, minY, maxY);

        const bodyColor = isBot ? "#ea580c" : "#0891b2";
        const trimColor = isBot ? "#fed7aa" : "#67e8f9";
        const hairColor = isBot ? "#451a03" : "#1e293b";

        const baseBridgeOffset = tipOffset - pullback + 28 * sc;
        const bridgePos = {
            x: cuePt.x - dirX * baseBridgeOffset,
            y: cuePt.y - dirY * baseBridgeOffset
        };
        const gripPos = {
            x: cuePt.x - dirX * (tipOffset + 78 * sc),
            y: cuePt.y - dirY * (tipOffset + 78 * sc)
        };

        ctx.save();
        // Arms connecting shoulders to bridge & grip hands
        ctx.strokeStyle = bodyColor;
        ctx.lineWidth = 7 * sc;
        ctx.lineCap = "round";
        const perpX = -dirY;
        const perpY = dirX;

        ctx.beginPath();
        ctx.moveTo(cx - perpX * 14 * sc, cy - perpY * 14 * sc);
        ctx.lineTo(bridgePos.x, bridgePos.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx + perpX * 14 * sc, cy + perpY * 14 * sc);
        ctx.lineTo(gripPos.x, gripPos.y);
        ctx.stroke();

        // Hands
        ctx.fillStyle = "#f5d0b5";
        for (const hand of [bridgePos, gripPos]) {
            ctx.beginPath();
            ctx.arc(hand.x, hand.y, 4.5 * sc, 0, Math.PI * 2);
            ctx.fill();
        }

        // Character torso & head
        ctx.translate(cx, cy);
        ctx.rotate(screenAngle);

        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.beginPath();
        ctx.ellipse(-2 * sc, 3 * sc, 13 * sc, 21 * sc, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = bodyColor;
        ctx.strokeStyle = trimColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, 12 * sc, 19 * sc, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Head + hair/cap
        ctx.fillStyle = "#f5d0b5";
        ctx.beginPath();
        ctx.arc(4 * sc, 0, 9.5 * sc, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = hairColor;
        ctx.beginPath();
        ctx.arc(1.5 * sc, 0, 9.2 * sc, Math.PI * 0.45, Math.PI * 1.55);
        ctx.fill();

        // Cap visor / headband facing cue
        ctx.fillStyle = trimColor;
        ctx.beginPath();
        ctx.arc(6 * sc, 0, 7 * sc, -Math.PI * 0.35, Math.PI * 0.35);
        ctx.fill();

        ctx.restore();
    }

    _drawParticles(ctx) {
        ctx.save();
        for (const p of this.particles) {
            const sp = this._toScreen(p.x, p.y);
            ctx.globalAlpha = clamp(p.life, 0, 1);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, Math.max(1, p.size * this.view.scale), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _drawBottomControlsHint(ctx, W, H) {
        const barW = Math.min(W - 16, 520);
        const barX = (W - barW) / 2;
        const barY = H - 76;

        ctx.save();
        ctx.fillStyle = "rgba(9, 14, 26, 0.78)";
        this._roundRect(ctx, barX, barY, barW, 28, 14);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
        ctx.lineWidth = 1;
        ctx.stroke();

        let text = "";
        let color = "#e2e8f0";
        if (this.phase === "charge") {
            const pct = Math.round(this.chargePower * 100);
            color = pct > 75 ? "#ff8a65" : "#00f2fe";
            text = this.inputMode === "two-direction"
                ? `⚡ Сила: ${pct}% — Нахиліть дошку вліво/вправо для УДАРУ!`
                : `🔥 Сила: ${pct}% — Нахил ВПЕРЕД для УДАРУ! (або 0° щоб скасувати)`;
        } else if (this.phase === "bot_aim") {
            color = "#ffb74d";
            text = "🤖 Суперник обирає позицію та виконує удар...";
        } else if (this.phase === "rolling" || this.phase === "strike") {
            color = "#94a3b8";
            text = "🎱 Кулі рухаються — тримайте рівновагу в центрі";
        } else {
            text = this.inputMode === "two-direction"
                ? "◀▶ Нахил — приціл  •  Тримайте 0° (1с) — шкала сили"
                : "◀▶ Нахил — приціл  •  ⬇ Назад — сила  •  ⬆ Вперед — удар";
        }

        const fontSize = Math.max(10, Math.min(12.5, barW * 0.032));
        ctx.font = `600 ${fontSize}px sans-serif`;
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, W / 2, barY + 14, barW - 18);
        ctx.restore();
    }

    _drawBanner(ctx, W, H) {
        const alpha = clamp(this.bannerTimer / 0.4, 0, 1);
        ctx.save();
        ctx.globalAlpha = alpha;
        const fontSize = Math.max(14, Math.min(24, W * 0.045));
        ctx.font = `800 ${fontSize}px sans-serif`;
        const boxW = Math.min(W - 24, ctx.measureText(this.bannerText).width + 38);
        const boxH = fontSize + 20;
        const bx = (W - boxW) / 2;
        const by = H * 0.2 - boxH / 2;

        ctx.fillStyle = "rgba(9, 17, 30, 0.88)";
        this._roundRect(ctx, bx, by, boxW, boxH, 12);
        ctx.fill();
        ctx.strokeStyle = "#00f2fe";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(this.bannerText, W / 2, by + boxH / 2);
        ctx.restore();
    }

    _roundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, width, height, radius);
        } else {
            ctx.rect(x, y, width, height);
        }
    }

    stop() {
        this.active = false;
        this.balls.length = 0;
        this.pocketAnims.length = 0;
        this.particles.length = 0;
        this._lastScoreHud = "";
        this._lastStateHud = "";
        if (this._uiContainer && this._uiClickHandler) {
            this._uiContainer.removeEventListener("click", this._uiClickHandler);
        }
        this._uiContainer = null;
        this._uiClickHandler = null;
        if (this.api && typeof this.api.clearCustomHTML === "function") {
            this.api.clearCustomHTML();
        }
    }
}

BilliardsGame.inputRequirements = { directions: 4, inputMode: "4way" };
if (typeof window.RehabGames.register === "function") {
    window.RehabGames.register("billiards", BilliardsGame, { directions: 4, inputMode: "4way" });
} else {
    window.RehabGames.billiards = BilliardsGame;
}
