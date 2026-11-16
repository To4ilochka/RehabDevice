window.RehabGames = window.RehabGames || {};

class Balance3DGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = 1;
        this.height = 1;
        this.active = false;
        this.particles = [];
        this.orb = null;
        this.orbsCollected = 0;
        this.score = 0;
        this.pulsePhase = 0;
    }

    init(canvas, options) {
        const opts = options || {};
        this.inputMode = opts.inputMode || "four-direction";
        this.calibMin = Number.isFinite(opts.calibMin) ? opts.calibMin : -20;
        this.calibMax = Number.isFinite(opts.calibMax) ? opts.calibMax : 20;
        if (this.calibMax <= this.calibMin) {
            this.calibMin = -20;
            this.calibMax = 20;
        }
        this.ctx = canvas.getContext("2d");
        const bounds = canvas.getBoundingClientRect();
        this.resize(bounds.width || canvas.clientWidth || 1, bounds.height || canvas.clientHeight || 1);
        this.active = true;
        this.bestTime = 0;
        this._resetRound();
    }

    resize(width, height) {
        this.width = Math.max(1, Number(width) || 1);
        this.height = Math.max(1, Number(height) || 1);
    }

    _spawnOrb() {
        const limit = this._boardRadius() * 0.78;
        const maxRange = limit * 0.62;
        let ox = 0;
        let oy = 0;
        for (let attempt = 0; attempt < 12; attempt++) {
            ox = (Math.random() * 2 - 1) * maxRange;
            oy = this.inputMode === "two-direction" ? 0 : (Math.random() * 2 - 1) * maxRange;
            if (Math.hypot(ox - this.robotX, oy - this.robotY) >= limit * 0.30) {
                break;
            }
        }
        this.orb = { x: ox, y: oy };
    }

    _resetRound() {
        this.bestTime = Math.max(this.bestTime || 0, this.roundTime || 0);
        this.roundTime = 0;
        this.robotX = 0;
        this.robotY = 0;
        this.velocityX = 0;
        this.velocityY = 0;
        this.tiltX = 0;
        this.tiltY = 0;
        this.orbsCollected = 0;
        this.score = 0;
        this.pulsePhase = 0;
        this.gameOver = false;
        this.resetTimer = 0;
        this.particles = [];
        this._spawnOrb();
        this._updateHud("Сфери: 0 | Час: 0,0 с", "Нахиляйте дошку, щоб зібрати енергосфери");
    }

    update(angle, dt) {
        const input = arguments[2];
        if (input?.mode) this.inputMode = input.mode;
        if (!this.active) return;
        const step = Number.isFinite(dt) ? Math.min(0.05, Math.max(0, dt)) : 0;
        const roll = input
            ? this._axis(input, "Horizontal")
            : (Number.isFinite(angle)
                ? Math.max(-1, Math.min(1, (angle - (this.calibMin + this.calibMax) / 2) / Math.max(1, (this.calibMax - this.calibMin) / 2)))
                : 0);
        const pitch = this.inputMode === "two-direction" ? 0 : this._axis(input, "Vertical");
        const limit = this._boardRadius() * 0.78;

        this.pulsePhase += step * 4.5;
        this._updateParticles(step);
        if (this.gameOver) {
            this.resetTimer -= step;
            if (this.resetTimer <= 0) this._resetRound();
            return;
        }

        this.roundTime += step;
        const targetTilt = 0.36;
        this.tiltX += (roll * targetTilt - this.tiltX) * Math.min(1, step * 9);
        this.tiltY += (pitch * targetTilt - this.tiltY) * Math.min(1, step * 9);

        // Ортогональна фізика кочення вниз по схилу:
        // +roll (вправо) -> +robotX; +pitch (вперед/вгору) -> -robotY (до дальнього краю "ВПЕРЕД")
        const restoringForce = 0.35;
        const damping = 2.6;
        const gravity = 410;
        this.velocityX += (Math.sin(this.tiltX) * gravity - this.robotX * restoringForce - this.velocityX * damping) * step;
        this.velocityY += (-Math.sin(this.tiltY) * gravity - this.robotY * restoringForce - this.velocityY * damping) * step;
        this.robotX += this.velocityX * step;
        this.robotY += this.velocityY * step;

        if (this.inputMode === "two-direction") {
            this.velocityY = 0;
            this.robotY = 0;
            if (this.orb && this.orb.y !== 0) {
                this.orb.y = 0;
            }
        }

        if (!this.orb) {
            this._spawnOrb();
        }
        const collectRadius = Math.max(16, limit * 0.24);
        if (this.orb && Math.hypot(this.robotX - this.orb.x, this.robotY - this.orb.y) <= collectRadius) {
            const hitPos = this._project(this.orb.x, this.orb.y, 12);
            this._spawnBurst(hitPos.x, hitPos.y, "#00f2fe", 14);
            this.orbsCollected++;
            this.score += 10;
            this._spawnOrb();
        }

        const danger = Math.max(Math.abs(this.robotX), Math.abs(this.robotY)) / limit;
        const state = danger < 0.45
            ? "Збирайте сфери та тримайте баланс"
            : danger < 0.76
                ? "Обережно: край платформи"
                : "Небезпека: робот біля краю!";
        const hudScore = `Сфери: ${this.orbsCollected} | Час: ${this.roundTime.toFixed(1).replace(".", ",")} с`;
        this._updateHud(hudScore, state);

        if (Math.abs(this.robotX) > limit || Math.abs(this.robotY) > limit) {
            this.gameOver = true;
            this.resetTimer = 2.5;
            this.bestTime = Math.max(this.bestTime, this.roundTime);
            this._createExplosion();
            this._updateHud(hudScore, "Робот з'їхав із платформи");
        }
    }

    _axis(input, axis) {
        const value = input?.getAxis(axis);
        return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }

    _boardRadius() {
        return Math.max(38, Math.min(this.width * 0.31, this.height * 0.22, 195));
    }

    _project(x, y, z = 0) {
        const radius = this._boardRadius();
        const centerX = this.width / 2;
        const centerY = this.height * 0.56;
        // Симетрична фронтальна трапецієподібна перспектива (без діагонального перекосу X від Y)
        const persp = 1 / Math.max(0.58, 1 - y / (radius * 3.4));
        // Край, куди нахилена дошка, фізично опускається вниз на екрані
        const elevation = -Math.sin(this.tiltX) * x + Math.sin(this.tiltY) * y + z;
        return {
            x: centerX + x * 0.94 * persp,
            y: centerY + y * 0.50 * persp - elevation * persp,
            scale: persp
        };
    }

    _updateHud(score, state) {
        this.api.updateHUD("hudScore", score);
        this.api.updateHUD("hudBotState", state);
    }

    _updateParticles(dt) {
        for (let index = this.particles.length - 1; index >= 0; index--) {
            const particle = this.particles[index];
            particle.x += particle.vx * dt;
            particle.y += particle.vy * dt;
            particle.vy += 180 * dt;
            particle.life -= dt;
            if (particle.life <= 0) this.particles.splice(index, 1);
        }
    }

    _spawnBurst(px, py, color, count) {
        for (let index = 0; index < count; index++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 95;
            this.particles.push({
                x: px,
                y: py,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 25,
                life: 0.45 + Math.random() * 0.45,
                color: index % 2 ? "#ffd166" : color
            });
        }
    }

    _createExplosion() {
        const point = this._project(this.robotX, this.robotY, 8);
        this._spawnBurst(point.x, point.y, "#43d9d3", 24);
    }

    draw(ctx) {
        if (!this.active) return;
        this.ctx = ctx;
        const width = this.width;
        const height = this.height;
        const radius = this._boardRadius();
        const corners = [
            this._project(-radius, -radius),
            this._project(radius, -radius),
            this._project(radius, radius),
            this._project(-radius, radius)
        ];

        ctx.save();
        const background = ctx.createLinearGradient(0, 0, 0, height);
        background.addColorStop(0, "#07131d");
        background.addColorStop(0.62, "#12313a");
        background.addColorStop(1, "#284246");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        this._drawGrid(ctx, width, height);

        // Товщина платформи (3D борт)
        ctx.beginPath();
        corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y + 15) : ctx.moveTo(point.x, point.y + 15));
        ctx.closePath();
        ctx.fillStyle = "#1d3138";
        ctx.fill();
        ctx.strokeStyle = "#8fb3ad";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Верхня площина платформи
        ctx.beginPath();
        corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.closePath();
        const board = ctx.createLinearGradient(width * 0.25, height * 0.36, width * 0.75, height * 0.74);
        board.addColorStop(0, "#43d9d3");
        board.addColorStop(0.52, "#2f8f96");
        board.addColorStop(1, "#1e5b65");
        ctx.fillStyle = board;
        ctx.fill();
        ctx.strokeStyle = "#d2f0e5";
        ctx.lineWidth = 2.2;
        ctx.stroke();

        this._drawBoardMarks(ctx, radius);
        this._drawDirectionLabels(ctx, radius);
        this._drawOrb(ctx, radius);
        this._drawRobot(ctx);
        this._drawParticles(ctx);
        if (this.gameOver) this._drawGameOver(ctx, width, height);
        ctx.restore();
    }

    _drawGrid(ctx, width, height) {
        ctx.save();
        ctx.strokeStyle = "rgba(197, 232, 221, 0.13)";
        ctx.lineWidth = 1;
        const horizon = height * 0.36;
        for (let index = -8; index <= 8; index++) {
            ctx.beginPath();
            ctx.moveTo(width / 2 + index * 12, horizon);
            ctx.lineTo(width / 2 + index * width * 0.12, height);
            ctx.stroke();
        }
        for (let index = 0; index < 8; index++) {
            const y = horizon + Math.pow(index / 7, 2) * (height - horizon);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawBoardMarks(ctx, radius) {
        ctx.save();
        ctx.strokeStyle = "rgba(239, 249, 235, 0.26)";
        ctx.lineWidth = 1;
        for (const fraction of [-0.5, 0, 0.5]) {
            const vStart = this._project(fraction * radius, -radius * 0.82);
            const vEnd = this._project(fraction * radius, radius * 0.82);
            ctx.beginPath();
            ctx.moveTo(vStart.x, vStart.y);
            ctx.lineTo(vEnd.x, vEnd.y);
            ctx.stroke();

            const hStart = this._project(-radius * 0.82, fraction * radius);
            const hEnd = this._project(radius * 0.82, fraction * radius);
            ctx.beginPath();
            ctx.moveTo(hStart.x, hStart.y);
            ctx.lineTo(hEnd.x, hEnd.y);
            ctx.stroke();
        }

        // Безпечна межа (0.78 radius)
        const safe = radius * 0.78;
        const safeCorners = [
            this._project(-safe, -safe),
            this._project(safe, -safe),
            this._project(safe, safe),
            this._project(-safe, safe)
        ];
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "rgba(255, 248, 206, 0.38)";
        ctx.beginPath();
        safeCorners.forEach((pt, idx) => idx ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y));
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }

    _drawDirectionLabels(ctx, radius) {
        ctx.save();
        const fontSize = Math.max(10, Math.min(13, radius * 0.085));
        ctx.font = `700 ${fontSize}px sans-serif`;
        ctx.fillStyle = "rgba(226, 248, 243, 0.75)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const topPt = this._project(0, -radius * 1.12);
        const bottomPt = this._project(0, radius * 1.12);
        const leftPt = this._project(-radius * 1.12, 0);
        const rightPt = this._project(radius * 1.12, 0);

        if (this.inputMode !== "two-direction") {
            ctx.fillText("▲ ВПЕРЕД", topPt.x, topPt.y);
            ctx.fillText("▼ НАЗАД", bottomPt.x, bottomPt.y + 10);
        }
        ctx.fillText("◀", leftPt.x, leftPt.y);
        ctx.fillText("▶", rightPt.x, rightPt.y);
        ctx.restore();
    }

    _drawOrb(ctx, radius) {
        if (!this.orb) return;
        const pulse = 1 + Math.sin(this.pulsePhase) * 0.14;
        const groundPt = this._project(this.orb.x, this.orb.y, 1);
        const orbPt = this._project(this.orb.x, this.orb.y, 13 + Math.sin(this.pulsePhase) * 2.5);
        const orbRadius = Math.max(7, Math.min(15, radius * 0.095)) * (orbPt.scale || 1) * pulse;

        ctx.save();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.65)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(groundPt.x, groundPt.y, orbRadius * 1.35, orbRadius * 0.62, 0, 0, Math.PI * 2);
        ctx.stroke();

        const glow = ctx.createRadialGradient(orbPt.x - orbRadius * 0.25, orbPt.y - orbRadius * 0.25, 1, orbPt.x, orbPt.y, orbRadius * 1.4);
        glow.addColorStop(0, "#ffffff");
        glow.addColorStop(0.45, "#ffd166");
        glow.addColorStop(1, "rgba(255, 145, 0, 0.15)");
        ctx.fillStyle = glow;
        ctx.shadowBlur = 14;
        ctx.shadowColor = "#ffd166";
        ctx.beginPath();
        ctx.arc(orbPt.x, orbPt.y, orbRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawRobot(ctx) {
        const shadowPt = this._project(this.robotX, this.robotY, 1);
        const point = this._project(this.robotX, this.robotY, 18);
        const baseSize = Math.max(11, Math.min(this._boardRadius() * 0.18, 26));
        const size = baseSize * Math.max(0.82, Math.min(1.22, point.scale || 1));

        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.36)";
        ctx.beginPath();
        ctx.ellipse(shadowPt.x, shadowPt.y, size * 0.92, size * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();

        const shell = ctx.createRadialGradient(point.x - size * 0.35, point.y - size * 0.4, 2, point.x, point.y, size);
        shell.addColorStop(0, "#f4fff5");
        shell.addColorStop(0.35, "#80e5d4");
        shell.addColorStop(1, "#226b78");
        ctx.fillStyle = shell;
        ctx.beginPath();
        ctx.arc(point.x, point.y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#dcfff0";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#132a32";
        ctx.beginPath();
        this._roundRect(ctx, point.x - size * 0.55, point.y - size * 0.18, size * 1.1, size * 0.38, size * 0.16);
        ctx.fill();

        const eyeOffsetX = Math.max(-size * 0.24, Math.min(size * 0.24, this.velocityX * 0.02));
        const eyeOffsetY = Math.max(-size * 0.08, Math.min(size * 0.08, this.velocityY * 0.01));
        ctx.fillStyle = this.gameOver ? "#ff6b5f" : "#fff8ce";
        ctx.beginPath();
        ctx.arc(point.x + eyeOffsetX, point.y + eyeOffsetY, size * 0.13, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _roundRect(ctx, x, y, width, height, radius) {
        if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, width, height, radius);
        } else {
            ctx.rect(x, y, width, height);
        }
    }

    _drawParticles(ctx) {
        ctx.save();
        for (const particle of this.particles) {
            ctx.globalAlpha = Math.max(0, Math.min(1, particle.life));
            ctx.fillStyle = particle.color;
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    _drawGameOver(ctx, width, height) {
        ctx.save();
        ctx.fillStyle = "rgba(4, 15, 20, 0.75)";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#fff2cb";
        ctx.textAlign = "center";
        ctx.font = `700 ${Math.max(18, Math.min(30, width * 0.075))}px sans-serif`;
        ctx.fillText("РАУНД ЗАВЕРШЕНО", width / 2, height * 0.45);
        ctx.font = `600 ${Math.max(14, Math.min(20, width * 0.05))}px sans-serif`;
        ctx.fillText(`Зібрано сфер: ${this.orbsCollected} | Утримання: ${this.roundTime.toFixed(1).replace(".", ",")} с`, width / 2, height * 0.54);
        ctx.font = "14px sans-serif";
        ctx.fillText("Новий раунд розпочнеться автоматично", width / 2, height * 0.61);
        ctx.restore();
    }

    stop() {
        this.active = false;
        this.particles.length = 0;
    }
}

Balance3DGame.inputRequirements = { directions: 4, inputMode: "4way" };
if (typeof window.RehabGames.register === "function") {
    window.RehabGames.register("balance3d", Balance3DGame, { directions: 4, inputMode: "4way" });
} else {
    window.RehabGames.balance3d = Balance3DGame;
}
