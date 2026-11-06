window.RehabGames = window.RehabGames || {};

class Balance3DGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = 1;
        this.height = 1;
        this.active = false;
        this.particles = [];
    }

    init(canvas) {
        this.ctx = canvas.getContext("2d");
        const bounds = canvas.getBoundingClientRect();
        this.resize(bounds.width || canvas.clientWidth || 1, bounds.height || canvas.clientHeight || 1);
        this.active = true;
        this._resetRound();
    }

    resize(width, height) {
        this.width = Math.max(1, Number(width) || 1);
        this.height = Math.max(1, Number(height) || 1);
    }

    _resetRound() {
        this.roundTime = 0;
        this.bestTime = Math.max(this.bestTime || 0, this.roundTime);
        this.robotX = 0;
        this.robotY = 0;
        this.velocityX = 0;
        this.velocityY = 0;
        this.tiltX = 0;
        this.tiltY = 0;
        this.gameOver = false;
        this.resetTimer = 0;
        this.particles = [];
        this._updateHud("Час: 0,0 с", "Тримайте робота в центрі");
    }

    update(angle, dt, input) {
        if (!this.active) return;
        const step = Number.isFinite(dt) ? Math.min(0.05, Math.max(0, dt)) : 0;
        const roll = this._axis(input, "Horizontal");
        const pitch = this._axis(input, "Vertical");
        const limit = this._boardRadius() * 0.78;

        this._updateParticles(step);
        if (this.gameOver) {
            this.resetTimer -= step;
            if (this.resetTimer <= 0) this._resetRound();
            return;
        }

        this.roundTime += step;
        const targetTilt = 0.38;
        this.tiltX += (roll * targetTilt - this.tiltX) * Math.min(1, step * 8);
        this.tiltY += (pitch * targetTilt - this.tiltY) * Math.min(1, step * 8);

        const restoringForce = 1.25;
        const damping = 2.8;
        const gravity = 430;
        this.velocityX += (Math.sin(this.tiltX) * gravity - this.robotX * restoringForce - this.velocityX * damping) * step;
        this.velocityY += (Math.sin(this.tiltY) * gravity - this.robotY * restoringForce - this.velocityY * damping) * step;
        this.robotX += this.velocityX * step;
        this.robotY += this.velocityY * step;

        const danger = Math.max(Math.abs(this.robotX), Math.abs(this.robotY)) / limit;
        const state = danger < 0.35 ? "Тримайте робота в центрі" :
            danger < 0.72 ? "Обережно: край платформи" : "Небезпека: робот біля краю";
        this._updateHud(`Час: ${this.roundTime.toFixed(1).replace(".", ",")} с`, state);

        if (Math.abs(this.robotX) > limit || Math.abs(this.robotY) > limit) {
            this.gameOver = true;
            this.resetTimer = 2.5;
            this.bestTime = Math.max(this.bestTime, this.roundTime);
            this._createExplosion();
            this._updateHud(`Час: ${this.roundTime.toFixed(1).replace(".", ",")} с`, "Робот з'їхав із платформи");
        }
    }

    _axis(input, axis) {
        const value = input?.getAxis(axis);
        return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }

    _boardRadius() {
        return Math.max(30, Math.min(this.width * 0.27, this.height * 0.16, 170));
    }

    _project(x, y, z = 0) {
        const centerX = this.width / 2;
        const centerY = this.height * 0.59;
        const height = Math.tan(this.tiltX) * x + Math.tan(this.tiltY) * y + z;
        return {
            x: centerX + x * 0.86 + y * 0.42,
            y: centerY + x * 0.08 + y * 0.36 - height
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

    _createExplosion() {
        const point = this._project(this.robotX, this.robotY, 8);
        for (let index = 0; index < 24; index++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 35 + Math.random() * 120;
            this.particles.push({
                x: point.x,
                y: point.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 35,
                life: 0.6 + Math.random() * 0.6,
                color: index % 2 ? "#ffd166" : "#43d9d3"
            });
        }
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

        ctx.beginPath();
        corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y + 14) : ctx.moveTo(point.x, point.y + 14));
        ctx.closePath();
        ctx.fillStyle = "#263b42";
        ctx.fill();
        ctx.strokeStyle = "#b0c7c3";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        corners.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.closePath();
        const board = ctx.createLinearGradient(width * 0.2, height * 0.4, width * 0.8, height * 0.72);
        board.addColorStop(0, "#43d9d3");
        board.addColorStop(0.52, "#318e94");
        board.addColorStop(1, "#22616b");
        ctx.fillStyle = board;
        ctx.fill();
        ctx.strokeStyle = "#d2f0e5";
        ctx.lineWidth = 2;
        ctx.stroke();

        this._drawBoardMarks(ctx, radius);
        this._drawRobot(ctx);
        this._drawParticles(ctx);
        if (this.gameOver) this._drawGameOver(ctx, width, height);
        ctx.restore();
    }

    _drawGrid(ctx, width, height) {
        ctx.save();
        ctx.strokeStyle = "rgba(197, 232, 221, 0.14)";
        ctx.lineWidth = 1;
        const horizon = height * 0.39;
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
        ctx.strokeStyle = "rgba(239, 249, 235, 0.3)";
        ctx.lineWidth = 1;
        for (const fraction of [-0.5, 0, 0.5]) {
            const start = this._project(fraction * radius, -radius * 0.72);
            const end = this._project(fraction * radius, radius * 0.72);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawRobot(ctx) {
        const point = this._project(this.robotX, this.robotY, 18);
        const size = Math.max(11, Math.min(this._boardRadius() * 0.2, 28));
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.beginPath();
        ctx.ellipse(point.x, point.y + size * 0.72, size * 0.9, size * 0.28, 0, 0, Math.PI * 2);
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
        ctx.fillStyle = this.gameOver ? "#ff6b5f" : "#fff8ce";
        ctx.beginPath();
        ctx.arc(point.x + Math.max(-size * 0.24, Math.min(size * 0.24, this.velocityX * 0.02)), point.y, size * 0.12, 0, Math.PI * 2);
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
        ctx.fillStyle = "rgba(4, 15, 20, 0.72)";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#fff2cb";
        ctx.textAlign = "center";
        ctx.font = `700 ${Math.max(18, Math.min(30, width * 0.075))}px sans-serif`;
        ctx.fillText("РАУНД ЗАВЕРШЕНО", width / 2, height * 0.47);
        ctx.font = `600 ${Math.max(14, Math.min(20, width * 0.05))}px sans-serif`;
        ctx.fillText(`Утримання: ${this.roundTime.toFixed(1).replace(".", ",")} с`, width / 2, height * 0.55);
        ctx.font = `14px sans-serif`;
        ctx.fillText("Новий раунд розпочнеться автоматично", width / 2, height * 0.61);
        ctx.restore();
    }

    stop() {
        this.active = false;
        this.particles.length = 0;
    }
}

Balance3DGame.inputRequirements = { directions: 4 };
if (typeof window.RehabGames.register === "function") {
    window.RehabGames.register("balance3d", Balance3DGame, { directions: 4 });
} else {
    window.RehabGames.balance3d = Balance3DGame;
}
